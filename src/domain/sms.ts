/**
 * Incoming SMS (MO) commands. Applink delivers the text with the keyword
 * included ("BIPOD SAFE"); we also accept it without the keyword.
 *
 *   BIPOD SAFE [place]            I am safe
 *   BIPOD HELP [need] [place]     I need help (need: rescue | medical | food | other)
 *   BIPOD MOVE [place]            moving to a shelter
 *   BIPOD OK <ref>                family/volunteer: I am handling it
 *   BIPOD SAFE <ref>              family: I know they are safe
 *   BIPOD HELP <ref>              family: they need help, alert volunteers
 *   BIPOD DONE <ref>              close a request
 *   BIPOD ADD <number> [name]     add a family contact
 *   BIPOD YES / BIPOD NO             accept / decline being a family contact
 *   BIPOD JOIN                    join
 *   BIPOD STOP                    leave (also STOP, UNSUB, OFF)
 *   BIPOD STATUS, BIPOD INFO
 */

import { config } from "../config.ts";
import type { Ctx } from "../context.ts";
import {
  addContact,
  answerInvites,
  contactsOf,
  displayName,
  ensurePerson,
  type Person,
} from "./people.ts";
import {
  acknowledge,
  checkIn,
  confirmSafeOnBehalf,
  latestAlertFor,
  markDone,
  reportNeedsHelp,
} from "./incidents.ts";
import { optIn, optOut } from "./subscriptions.ts";
import { queueSms } from "./outbox.ts";
import { clean, sms } from "./texts.ts";

export type SmsCommand =
  | { kind: "safe"; ref?: string; place?: string }
  | { kind: "help"; ref?: string; need?: string; place?: string }
  | { kind: "moving"; place?: string }
  | { kind: "ack"; ref?: string }
  | { kind: "done"; ref?: string }
  | { kind: "add"; number: string; name?: string }
  | { kind: "accept" }
  | { kind: "decline" }
  | { kind: "join"; area?: string }
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "info" }
  | { kind: "unknown"; text: string };

const WORDS: Record<string, SmsCommand["kind"]> = {
  SAFE: "safe", BHALO: "safe", NIRAPOD: "safe", FINE: "safe",
  HELP: "help", SOS: "help", BIPOD: "help", UDDHAR: "help",
  MOVE: "moving", MOVING: "moving", SHELTER: "moving",
  OK: "ack", ACK: "ack", HANDLING: "ack",
  DONE: "done", RESOLVED: "done", FOUND: "done",
  ADD: "add",
  YES: "accept", ACCEPT: "accept", HA: "accept",
  NO: "decline", DECLINE: "decline", NA: "decline",
  JOIN: "join", START: "join", REG: "join",
  STOP: "stop", UNSUB: "stop", OFF: "stop", LEAVE: "stop",
  STATUS: "status",
  INFO: "info", MENU: "info", "?": "info",
};

const NEED_WORDS: Record<string, string> = {
  RESCUE: "rescue", UDDHAR: "rescue", FLOOD: "rescue", WATER: "rescue", BOAT: "rescue",
  MEDICAL: "medical", DOCTOR: "medical", DAKTAR: "medical", OSHUDH: "medical", SICK: "medical",
  FOOD: "food", KHABAR: "food", PANI: "food",
  OTHER: "other",
};

const REF = /^[SHMT]\d{1,7}$/;

export function parseSms(text: string, keyword = config.applink.keyword): SmsCommand {
  const words = text.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (words.length && words[0].toUpperCase() === keyword.toUpperCase()) words.shift();
  if (words.length === 0) return { kind: "info" };

  const head = words[0].toUpperCase().replace(/[^A-Z?]/g, "");
  const kind = WORDS[head];
  const rest = words.slice(1);
  const ref = rest[0] && REF.test(rest[0].toUpperCase()) ? rest[0].toUpperCase() : undefined;
  const afterRef = ref ? rest.slice(1) : rest;

  switch (kind) {
    case "safe":
      return { kind, ref, place: afterRef.join(" ") || undefined };
    case "help": {
      let need: string | undefined;
      let placeWords = afterRef;
      if (afterRef[0]) {
        const n = NEED_WORDS[afterRef[0].toUpperCase().replace(/[^A-Z]/g, "")];
        if (n) {
          need = n;
          placeWords = afterRef.slice(1);
        }
      }
      if (placeWords[0]?.toUpperCase() === "AT") placeWords = placeWords.slice(1);
      return { kind, ref, need, place: placeWords.join(" ") || undefined };
    }
    case "moving":
      return { kind, place: rest.join(" ") || undefined };
    case "ack":
    case "done":
      return { kind, ref };
    case "add": {
      const number = rest[0] ?? "";
      return { kind, number, name: rest.slice(1).join(" ") || undefined };
    }
    case "accept":
    case "decline":
    case "stop":
    case "status":
    case "info":
      return { kind } as SmsCommand;
    case "join":
      return { kind, area: rest.join(" ") || undefined };
    default:
      return { kind: "unknown", text: words.join(" ") };
  }
}

function reply(ctx: Ctx, to: Person, body: string, purpose = "reply"): void {
  queueSms(ctx, { address: to.subscriber_id, personId: to.id, purpose, body });
}

/** Handle one MO SMS. The callback route has already acknowledged and de-duplicated it. */
export async function handleIncomingSms(ctx: Ctx, sourceAddress: string, message: string): Promise<SmsCommand> {
  const cmd = parseSms(message);
  const person = ensurePerson(ctx.db, sourceAddress);

  switch (cmd.kind) {
    case "safe":
    case "help": {
      if (cmd.ref) {
        // A family member answering an alert about someone else.
        const outcome = cmd.kind === "safe" ? confirmSafeOnBehalf(ctx, cmd.ref, person) : reportNeedsHelp(ctx, cmd.ref, person);
        if (outcome.ok) {
          reply(ctx, person, cmd.kind === "safe"
            ? sms.guardianConfirmedSafe({ ref: cmd.ref, name: displayName(outcome.member), by: "You" })
            : `BipodMukti ${cmd.ref}: Thank you. Local volunteers are being alerted for ${displayName(outcome.member)}.`);
        } else {
          reply(ctx, person, outcome.reason === "closed" ? `BipodMukti ${cmd.ref}: This request is already closed.` : sms.notFound({ ref: cmd.ref }));
        }
        return cmd;
      }
      if (!person.is_member) {
        // Someone in trouble who never joined still gets help. No subscription without consent.
        ctx.db.run("UPDATE people SET is_member = 1 WHERE id = ?", person.id);
      }
      const res = checkIn(ctx, { member: { ...person, is_member: 1 }, kind: cmd.kind, need: cmd.kind === "help" ? cmd.need : undefined, place: cmd.place, channel: "sms" });
      reply(ctx, person, sms.checkInReceipt({ ref: res.incident.ref, kind: cmd.kind, told: res.told }), "receipt");
      return cmd;
    }
    case "moving": {
      const res = checkIn(ctx, { member: person, kind: "moving", place: cmd.place, channel: "sms" });
      reply(ctx, person, sms.checkInReceipt({ ref: res.incident.ref, kind: "moving", told: res.told }), "receipt");
      return cmd;
    }
    case "ack": {
      const ref = cmd.ref ?? latestAlertFor(ctx.db, person)?.ref;
      if (!ref) {
        reply(ctx, person, sms.help());
        return cmd;
      }
      const outcome = acknowledge(ctx, ref, person, "sms");
      if (!outcome.ok) {
        if (outcome.reason === "already") reply(ctx, person, sms.alreadyHandled({ ref, by: outcome.by ?? "someone" }));
        else if (outcome.reason === "closed") reply(ctx, person, `BipodMukti ${ref}: This request is already closed. Thank you.`);
        else reply(ctx, person, sms.notFound({ ref }));
      }
      return cmd;
    }
    case "done": {
      const ref = cmd.ref ?? latestAlertFor(ctx.db, person)?.ref;
      if (!ref) {
        reply(ctx, person, sms.help());
        return cmd;
      }
      const outcome = markDone(ctx, ref, person);
      reply(ctx, person, outcome.ok ? `BipodMukti ${ref}: Closed. Thank you.` : sms.notFound({ ref }));
      return cmd;
    }
    case "add": {
      const result = addContact(ctx, person, cmd.number, cmd.name ?? "");
      if (result.ok) {
        if (!person.is_member) ctx.db.run("UPDATE people SET is_member = 1 WHERE id = ?", person.id);
        reply(ctx, person, sms.contactAdded({ name: clean(cmd.name, 20) || cmd.number }));
      } else {
        reply(ctx, person, result.reason === "too_many" ? sms.tooManyContacts() : sms.badNumber());
      }
      return cmd;
    }
    case "accept":
    case "decline": {
      const members = answerInvites(ctx, person, cmd.kind === "accept");
      if (cmd.kind === "accept" && members.length) {
        reply(ctx, person, `BipodMukti: Thank you. You will get alerts for ${members.map((m) => displayName(m)).join(", ")}. Reply ${config.applink.keyword} OK <ref> when you handle one.`);
      } else if (cmd.kind === "decline") {
        reply(ctx, person, `BipodMukti: OK, you will not get alerts for ${members.length ? members.map((m) => displayName(m)).join(", ") : "anyone"}.`);
      } else {
        reply(ctx, person, sms.help());
      }
      return cmd;
    }
    case "join": {
      const result = await optIn(ctx, person, "sms-keyword", `SMS "${clean(message, 60)}"`);
      reply(ctx, result.person, sms.welcome(), "welcome");
      return cmd;
    }
    case "stop": {
      await optOut(ctx, person, "sms");
      // The opt-out confirmation is the last message this subscriber gets.
      queueSms(ctx, { address: person.subscriber_id, personId: person.id, purpose: "stop-confirm", body: sms.stopped() });
      return cmd;
    }
    case "status": {
      const open = ctx.db.get<{ ref: string }>(
        "SELECT ref FROM incidents WHERE member_id = ? AND status IN ('open','acknowledged') ORDER BY id DESC LIMIT 1",
        person.id,
      );
      reply(ctx, person, sms.status({ name: displayName(person), contacts: contactsOf(ctx.db, person.id).length, open: open?.ref }));
      return cmd;
    }
    default:
      reply(ctx, person, sms.help());
      return cmd;
  }
}
