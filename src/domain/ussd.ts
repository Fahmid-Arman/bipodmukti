/**
 * USSD menu for basic phones. Works with no data connection.
 *
 * Session state is keyed on the platform's sessionId (never our own), stored
 * in SQLite with a two-minute TTL. Shortcuts: dialling the code with extra
 * digits (e.g. *213*55*1#) feeds those digits as if typed, so "1" = SAFE at
 * home in a single dial.
 */

import { config } from "../config.ts";
import type { Ctx } from "../context.ts";
import { telFromTyped } from "../applink/address.ts";
import {
  addContact,
  area as getArea,
  areas as listAreas,
  contactsOf,
  displayName,
  ensurePerson,
  personById,
  MAX_CONTACTS,
  type Person,
} from "./people.ts";
import { checkIn } from "./incidents.ts";
import { optIn, optOut } from "./subscriptions.ts";
import { clean, screen, waitLabel } from "./texts.ts";

type State =
  | "ROOT"
  | "JOIN"
  | "JOIN_AREA"
  | "JOIN_CONSENT"
  | "JOIN_CONTACT"
  | "SAFE_WHERE"
  | "HELP_NEED"
  | "HELP_WHERE"
  | "MOVE_WHERE"
  | "PLACE_INPUT"
  | "CONTACTS"
  | "CONTACT_INPUT"
  | "SETTINGS"
  | "LEAVE_CONFIRM";

interface SessionData {
  areaId?: string;
  need?: string;
  /** What PLACE_INPUT completes. */
  pending?: "safe" | "help" | "moving";
  areaIds?: string[];
}

interface Session {
  session_id: string;
  subscriber_id: string;
  state: State;
  data: string;
  expires_at: number;
}

export interface UssdReply {
  text: string;
  op: "mt-cont" | "mt-fin";
}

const TTL_MS = 120_000;
const cont = (text: string): UssdReply => ({ text: screen(text), op: "mt-cont" });
const fin = (text: string): UssdReply => ({ text: screen(text), op: "mt-fin" });

function load(ctx: Ctx, sessionId: string): { state: State; data: SessionData } | undefined {
  const row = ctx.db.get<Session>("SELECT * FROM ussd_sessions WHERE session_id = ? AND expires_at > ?", sessionId, Date.now());
  if (!row) return undefined;
  return { state: row.state, data: JSON.parse(row.data) as SessionData };
}

function save(ctx: Ctx, sessionId: string, subscriberId: string, state: State, data: SessionData): void {
  ctx.db.run(
    `INSERT INTO ussd_sessions(session_id, subscriber_id, state, data, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, data = excluded.data, expires_at = excluded.expires_at`,
    sessionId,
    subscriberId,
    state,
    JSON.stringify(data),
    Date.now() + TTL_MS,
  );
}

function end(ctx: Ctx, sessionId: string): void {
  ctx.db.run("DELETE FROM ussd_sessions WHERE session_id = ?", sessionId);
}

export function purgeExpiredUssd(ctx: Ctx): void {
  ctx.db.run("DELETE FROM ussd_sessions WHERE expires_at <= ?", Date.now());
}

/** Digits dialled after the service code: "*213*55*2*1#" with code "*213*55#" -> ["2","1"]. */
export function shortcutInputs(dialled: string, code = config.applink.ussdCode): string[] {
  const parts = (s: string) => s.replace(/#$/, "").split("*").filter(Boolean);
  const base = parts(code);
  const got = parts(dialled.trim());
  if (got.length <= base.length) return [];
  for (let i = 0; i < base.length; i++) if (got[i] !== base[i]) return [];
  return got.slice(base.length);
}

/* ── Screens ──────────────────────────────────────────────────────────── */

function rootScreen(p: Person): string {
  return `BipodMukti - ${clean(displayName(p), 16)}\n1 I am SAFE\n2 I NEED HELP\n3 Moving to shelter\n4 Family contacts\n5 Settings\n0 Exit`;
}

/** The exact consent wording shown on the USSD screen; stored with the opt-in. */
function ussdConsent(): string {
  return `Join BipodMukti (${clean(config.applink.subscriptionTerms, 30)}). Family gets an SMS when you check in. Stop: ${config.applink.keyword} STOP`;
}

const JOIN_SCREEN = "BipodMukti: free safety check-in for floods and cyclones.\n1 Join\n2 How it works\n0 Exit";

function shelterOf(ctx: Ctx, p: Person): string {
  return clean(getArea(ctx.db, p.area_id)?.shelter, 28) || "Nearest shelter";
}

function homeLabel(p: Person): string {
  const h = clean(p.home_place, 24);
  return h ? `Home (${h})` : "Home";
}

function whereScreen(ctx: Ctx, p: Person, title: string): string {
  return `${title}\n1 ${homeLabel(p)}\n2 ${shelterOf(ctx, p)}\n3 Type a place\n0 Back`;
}

const HELP_NEED_SCREEN = "What help do you need?\n1 Rescue - water rising\n2 Medical\n3 Food / water\n4 Other\n0 Back";
const NEEDS_BY_KEY: Record<string, string> = { "1": "rescue", "2": "medical", "3": "food", "4": "other" };

function contactsScreen(ctx: Ctx, p: Person): string {
  const list = contactsOf(ctx.db, p.id);
  const lines = list.map((c, i) => `${i + 1} ${clean(c.guardian_name, 12) || "Contact"} ${c.status === "active" ? "ok" : "invited"}`);
  const add = list.length < MAX_CONTACTS ? "\n7 Add contact" : "";
  return `Family contacts:${lines.length ? `\n${lines.join("\n")}` : "\n(none yet)"}${add}\n0 Back`;
}

function areaScreen(ctx: Ctx): { text: string; ids: string[] } {
  const list = listAreas(ctx.db).slice(0, 6);
  return {
    text: `Choose your area:\n${list.map((a, i) => `${i + 1} ${clean(a.name, 18)}, ${clean(a.district, 12)}`).join("\n")}`,
    ids: list.map((a) => a.id),
  };
}

/* ── State machine ────────────────────────────────────────────────────── */

async function step(
  ctx: Ctx,
  sessionId: string,
  person: Person,
  state: State,
  data: SessionData,
  input: string,
): Promise<{ reply: UssdReply; state?: State; data?: SessionData }> {
  const key = input.trim();
  const again = (text: string) => ({ reply: cont(`Invalid choice.\n${text}`), state, data });

  switch (state) {
    case "JOIN":
      if (key === "1") {
        const a = areaScreen(ctx);
        return { reply: cont(a.text), state: "JOIN_AREA", data: { ...data, areaIds: a.ids } };
      }
      if (key === "2") {
        return { reply: fin(`Dial ${config.applink.ussdCode} in a flood or cyclone. Press 1 if safe, 2 for help. We SMS your family and, if they do not reply, local volunteers.`) };
      }
      if (key === "0") return { reply: fin("Stay safe.") };
      return again(JOIN_SCREEN);

    case "JOIN_AREA": {
      const idx = Number.parseInt(key, 10) - 1;
      const areaId = data.areaIds?.[idx];
      if (!areaId) return again(areaScreen(ctx).text);
      if (person.is_member) {
        ctx.db.run("UPDATE people SET area_id = ? WHERE id = ?", areaId, person.id);
        return { reply: fin(`Area updated to ${clean(getArea(ctx.db, areaId)?.name, 30)}.`) };
      }
      return { reply: cont(`${ussdConsent()}\n1 Yes, I agree\n2 No`), state: "JOIN_CONSENT", data: { ...data, areaId } };
    }

    case "JOIN_CONSENT":
      if (key === "1") {
        ctx.db.run("UPDATE people SET area_id = ? WHERE id = ?", data.areaId ?? null, person.id);
        await optIn(ctx, person, "ussd", ussdConsent());
        return { reply: cont("Joined. Enter a family member's mobile number (01XXXXXXXXX), or 0 to skip:"), state: "JOIN_CONTACT", data };
      }
      return { reply: fin("Not joined. Dial again any time.") };

    case "JOIN_CONTACT":
    case "CONTACT_INPUT": {
      if (key === "0") {
        return state === "JOIN_CONTACT"
          ? { reply: fin(`Done. Dial ${config.applink.ussdCode} any time: 1 = SAFE, 2 = HELP.`) }
          : { reply: cont(contactsScreen(ctx, person)), state: "CONTACTS", data };
      }
      if (!telFromTyped(key)) return { reply: cont("Number not valid. Enter 01XXXXXXXXX, or 0 to skip:"), state, data };
      const res = addContact(ctx, person, key);
      if (!res.ok) {
        return { reply: fin(res.reason === "too_many" ? "You already have 3 contacts." : "Could not add that number.") };
      }
      return { reply: fin(`Added. We sent them an SMS to accept. Dial ${config.applink.ussdCode} to check in.`) };
    }

    case "ROOT":
      if (key === "1") return { reply: cont(whereScreen(ctx, person, "SAFE - where are you?")), state: "SAFE_WHERE", data };
      if (key === "2") return { reply: cont(HELP_NEED_SCREEN), state: "HELP_NEED", data };
      if (key === "3") {
        return { reply: cont(`Moving to:\n1 ${shelterOf(ctx, person)}\n2 Relative's house\n3 Type a place\n0 Back`), state: "MOVE_WHERE", data };
      }
      if (key === "4") return { reply: cont(contactsScreen(ctx, person)), state: "CONTACTS", data };
      if (key === "5") return { reply: cont("Settings:\n1 Change area\n2 Leave BipodMukti\n0 Back"), state: "SETTINGS", data };
      if (key === "0") return { reply: fin("Stay safe.") };
      return again(rootScreen(person));

    case "SAFE_WHERE":
    case "HELP_WHERE": {
      if (key === "0") {
        return state === "SAFE_WHERE"
          ? { reply: cont(rootScreen(person)), state: "ROOT", data }
          : { reply: cont(HELP_NEED_SCREEN), state: "HELP_NEED", data };
      }
      const kind = state === "SAFE_WHERE" ? "safe" : "help";
      if (key === "1" || key === "2") {
        const place = key === "1" ? person.home_place || "home" : shelterOf(ctx, person);
        return { reply: finishCheckIn(ctx, person, kind, place, data.need) };
      }
      if (key === "3") return { reply: cont("Type the place or a landmark (e.g. Rajibpur school):"), state: "PLACE_INPUT", data: { ...data, pending: kind } };
      return again(whereScreen(ctx, person, kind === "safe" ? "SAFE - where are you?" : "Where are you now?"));
    }

    case "HELP_NEED": {
      if (key === "0") return { reply: cont(rootScreen(person)), state: "ROOT", data };
      const need = NEEDS_BY_KEY[key];
      if (!need) return again(HELP_NEED_SCREEN);
      return { reply: cont(whereScreen(ctx, person, "Where are you now?")), state: "HELP_WHERE", data: { ...data, need } };
    }

    case "MOVE_WHERE":
      if (key === "0") return { reply: cont(rootScreen(person)), state: "ROOT", data };
      if (key === "1") return { reply: finishCheckIn(ctx, person, "moving", shelterOf(ctx, person)) };
      if (key === "2") return { reply: finishCheckIn(ctx, person, "moving", "relative's house") };
      if (key === "3") return { reply: cont("Type where you are going:"), state: "PLACE_INPUT", data: { ...data, pending: "moving" } };
      return again(`Moving to:\n1 ${shelterOf(ctx, person)}\n2 Relative's house\n3 Type a place\n0 Back`);

    case "PLACE_INPUT": {
      const place = clean(input, 40);
      if (!place) return { reply: cont("Please type a place or landmark:"), state, data };
      return { reply: finishCheckIn(ctx, person, data.pending ?? "safe", place, data.need) };
    }

    case "CONTACTS":
      if (key === "0") return { reply: cont(rootScreen(person)), state: "ROOT", data };
      if (key === "7" && contactsOf(ctx.db, person.id).length < MAX_CONTACTS) {
        return { reply: cont("Enter the family member's mobile number (01XXXXXXXXX), or 0 to go back:"), state: "CONTACT_INPUT", data };
      }
      return again(contactsScreen(ctx, person));

    case "SETTINGS":
      if (key === "0") return { reply: cont(rootScreen(person)), state: "ROOT", data };
      if (key === "1") {
        const a = areaScreen(ctx);
        return { reply: cont(a.text), state: "JOIN_AREA", data: { ...data, areaIds: a.ids } };
      }
      if (key === "2") return { reply: cont("Leave BipodMukti? Your family will stop getting your alerts.\n1 Yes, leave\n2 No"), state: "LEAVE_CONFIRM", data };
      return again("Settings:\n1 Change area\n2 Leave BipodMukti\n0 Back");

    case "LEAVE_CONFIRM":
      if (key === "1") {
        await optOut(ctx, person, "ussd");
        return { reply: fin("You have left BipodMukti. Dial again to rejoin.") };
      }
      return { reply: cont(rootScreen(person)), state: "ROOT", data };
  }
}

function finishCheckIn(ctx: Ctx, person: Person, kind: "safe" | "help" | "moving", place: string, need?: string): UssdReply {
  const res = checkIn(ctx, { member: person, kind, need, place, channel: "ussd" });
  const ref = res.incident.ref;
  if (kind === "help") {
    const first = contactsOf(ctx.db, person.id)[0];
    const who = first ? clean(first.guardian_name, 14) || "your family" : "local volunteers";
    return fin(`Help request ${ref} sent to ${who}. If no reply in ${waitLabel(config.escalation.ackTimeoutSeconds)} we alert the next person. Emergency: 999`);
  }
  if (kind === "moving") return fin(`Noted (${ref}). We told ${res.told} family contact(s). Check in when you arrive.`);
  return fin(`Marked SAFE (${ref}). We told ${res.told} family contact(s). Stay safe.`);
}

/**
 * Handle one USSD callback and return the screen to send back with /ussd/send.
 * mo-init starts (or restarts) a session; mo-cont continues it.
 */
export async function handleUssd(
  ctx: Ctx,
  input: { sessionId: string; sourceAddress: string; message: string; ussdOperation: string },
): Promise<UssdReply> {
  let person = ensurePerson(ctx.db, input.sourceAddress);
  const isMember = person.is_member === 1 && !person.subscription_status.startsWith("UNREGISTERED");

  let state: State;
  let data: SessionData = {};
  let pendingInputs: string[];
  let reply: UssdReply;

  const existing = input.ussdOperation === "mo-cont" ? load(ctx, input.sessionId) : undefined;
  if (existing) {
    state = existing.state;
    data = existing.data;
    pendingInputs = [input.message];
    reply = cont("");
  } else {
    state = isMember ? "ROOT" : "JOIN";
    reply = cont(isMember ? rootScreen(person) : JOIN_SCREEN);
    pendingInputs = input.ussdOperation === "mo-init" ? shortcutInputs(input.message) : [input.message];
    if (input.ussdOperation !== "mo-init" && !existing) {
      // A continuation for a session we no longer have (expired): start over.
      pendingInputs = [];
    }
  }

  for (const key of pendingInputs) {
    person = personById(ctx.db, person.id)!;
    const out = await step(ctx, input.sessionId, person, state, data, key);
    reply = out.reply;
    if (reply.op === "mt-fin" || !out.state) {
      end(ctx, input.sessionId);
      return reply;
    }
    state = out.state;
    data = out.data ?? data;
  }

  save(ctx, input.sessionId, input.sourceAddress, state, data);
  return reply;
}
