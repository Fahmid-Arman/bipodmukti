/**
 * Check-ins and the escalation engine.
 *
 * A HELP check-in (or a missed roll call) opens an incident. The engine alerts
 * family contacts one at a time in priority order. Each contact gets
 * ACK_TIMEOUT_SECONDS to reply "BIPOD OK <ref>". No reply, or a failed SMS
 * delivery, moves the incident to the next contact, then to the local
 * volunteers, then flags it for the coordinator. Every step is written to the
 * incident timeline, so the console shows exactly who was told and who acted.
 */

import { config } from "../config.ts";
import type { Ctx } from "../context.ts";
import type { Db } from "../db.ts";
import { nowIso, isoIn } from "../db.ts";
import { displayNumber } from "../applink/address.ts";
import {
  area as getArea,
  contactsOf,
  displayName,
  personById,
  volunteersIn,
  type ContactRow,
  type Person,
} from "./people.ts";
import { clean, sms, waitLabel } from "./texts.ts";
import { onMessageFailed, queueSms, type MessageRow } from "./outbox.ts";
import { recordRollCallResponse, markTarget } from "./rollcall.ts";

export type IncidentKind = "safe" | "help" | "moving" | "missing";
export type Channel = "ussd" | "sms" | "web" | "rollcall" | "console";

export interface Incident {
  id: number;
  ref: string;
  member_id: number;
  kind: IncidentKind;
  need: string;
  place: string;
  channel: Channel;
  roll_call_id: number | null;
  status: "open" | "acknowledged" | "resolved" | "info";
  acknowledged_by: number | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  escalation_step: number;
  next_escalation_at: string | null;
  created_at: string;
}

const REF_PREFIX: Record<IncidentKind, string> = { safe: "S", help: "H", missing: "M", moving: "T" };
export const NEEDS = ["rescue", "medical", "food", "other"] as const;

export function incidentById(db: Db, id: number): Incident | undefined {
  return db.get<Incident>("SELECT * FROM incidents WHERE id = ?", id);
}

export function incidentByRef(db: Db, ref: string): Incident | undefined {
  return db.get<Incident>("SELECT * FROM incidents WHERE ref = ?", ref.trim().toUpperCase());
}

export function addEvent(ctx: Ctx, incidentId: number, type: string, detail = ""): void {
  ctx.db.run("INSERT INTO incident_events(incident_id, type, detail) VALUES (?, ?, ?)", incidentId, type, detail);
}

function createIncident(
  ctx: Ctx,
  p: { member: Person; kind: IncidentKind; need?: string; place: string; channel: Channel; rollCallId?: number | null; status: Incident["status"] },
): Incident {
  const id = ctx.db.tx(() => {
    const { lastId } = ctx.db.run(
      `INSERT INTO incidents(ref, member_id, kind, need, place, channel, roll_call_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      `TMP-${process.hrtime.bigint()}`,
      p.member.id,
      p.kind,
      p.need ?? "",
      clean(p.place, 40),
      p.channel,
      p.rollCallId ?? null,
      p.status,
    );
    ctx.db.run("UPDATE incidents SET ref = ? WHERE id = ?", `${REF_PREFIX[p.kind]}${lastId}`, lastId);
    return lastId;
  });
  return incidentById(ctx.db, id)!;
}

/* ── Escalation chain ─────────────────────────────────────────────────── */

type Stage =
  | { type: "guardian"; contact: ContactRow }
  | { type: "volunteers"; people: Person[] };

function chainFor(db: Db, member: Person): Stage[] {
  const stages: Stage[] = contactsOf(db, member.id).map((contact) => ({ type: "guardian", contact }));
  const volunteers = volunteersIn(db, member.area_id, member.id);
  if (volunteers.length) stages.push({ type: "volunteers", people: volunteers });
  return stages;
}

/** Send the alert for the incident's current step and arm the acknowledgement timer. */
export function escalate(ctx: Ctx, inc: Incident): void {
  const member = personById(ctx.db, inc.member_id);
  if (!member) return;
  const chain = chainFor(ctx.db, member);
  const step = inc.escalation_step;
  const areaRow = getArea(ctx.db, member.area_id);
  const areaName = areaRow ? `${areaRow.name}, ${areaRow.district}` : "their area";

  if (step >= chain.length) {
    ctx.db.run("UPDATE incidents SET next_escalation_at = NULL WHERE id = ?", inc.id);
    addEvent(ctx, inc.id, "needs_coordinator", "Every contact has been tried. Coordinator action needed.");
    ctx.bus.publish({ type: "incident", id: inc.id, summary: "needs coordinator" });
    return;
  }

  const stage = chain[step];
  if (stage.type === "guardian") {
    const c = stage.contact;
    const body =
      inc.kind === "missing"
        ? sms.missingAlert({ ref: inc.ref, name: displayName(member), area: areaName, title: rollCallTitle(ctx.db, inc) })
        : sms.helpAlert({
            ref: inc.ref,
            name: displayName(member),
            number: displayNumber(member.subscriber_id),
            need: inc.need || "other",
            place: inc.place,
            at: inc.created_at,
          });
    queueSms(ctx, { address: c.guardian_address, personId: c.guardian_id, incidentId: inc.id, purpose: "alert", body });
    addEvent(
      ctx,
      inc.id,
      "alerted",
      `Alerted ${clean(c.guardian_name, 24) || displayNumber(c.guardian_address)}${c.relation ? ` (${c.relation})` : ""}, family contact ${c.priority}${c.status === "invited" ? ", invite not yet accepted" : ""}`,
    );
  } else {
    for (const v of stage.people) {
      const body =
        inc.kind === "missing"
          ? sms.volunteerMissing({ ref: inc.ref, name: displayName(member), area: areaName })
          : sms.volunteerAlert({ ref: inc.ref, name: displayName(member), area: areaName, need: inc.need || "other", place: inc.place });
      queueSms(ctx, { address: v.subscriber_id, personId: v.id, incidentId: inc.id, purpose: "volunteer-alert", body });
    }
    addEvent(ctx, inc.id, "alerted", `Alerted ${stage.people.length} local volunteer(s): ${stage.people.map((p) => displayName(p)).join(", ")}`);
  }

  ctx.db.run(
    "UPDATE incidents SET escalation_step = ?, next_escalation_at = ? WHERE id = ?",
    step + 1,
    isoIn(config.escalation.ackTimeoutSeconds),
    inc.id,
  );
  ctx.bus.publish({ type: "incident", id: inc.id, summary: "escalated" });
}

function rollCallTitle(db: Db, inc: Incident): string {
  if (!inc.roll_call_id) return "safety";
  const row = db.get<{ title: string }>("SELECT title FROM roll_calls WHERE id = ?", inc.roll_call_id);
  return clean(row?.title, 30) || "safety";
}

/** Scheduler: move every open incident whose acknowledgement window has passed. */
export function processDueEscalations(ctx: Ctx): number {
  const due = ctx.db.all<Incident>(
    "SELECT * FROM incidents WHERE status = 'open' AND next_escalation_at IS NOT NULL AND next_escalation_at <= ?",
    nowIso(),
  );
  for (const inc of due) {
    addEvent(ctx, inc.id, "no_ack", `No acknowledgement within ${waitLabel(config.escalation.ackTimeoutSeconds)}`);
    escalate(ctx, inc);
  }
  return due.length;
}

/** A failed alert SMS (send error or delivery report) skips the wait. */
onMessageFailed((ctx, msg: MessageRow) => {
  if (!msg.incident_id || msg.purpose !== "alert") return;
  const inc = incidentById(ctx.db, msg.incident_id);
  if (!inc || inc.status !== "open") return;
  const latest = ctx.db.get<{ id: number }>(
    "SELECT id FROM messages WHERE incident_id = ? AND purpose = 'alert' ORDER BY id DESC LIMIT 1",
    inc.id,
  );
  if (latest?.id !== msg.id) return; // an older alert; we already moved on
  const who = displayName(personById(ctx.db, msg.person_id));
  addEvent(ctx, inc.id, "delivery_failed", `SMS to ${who} failed (${msg.status_detail ?? msg.status_code ?? "failed"}). Moving to next contact now.`);
  escalate(ctx, inc);
});

/* ── Check-ins ────────────────────────────────────────────────────────── */

export interface CheckInInput {
  member: Person;
  kind: "safe" | "help" | "moving";
  need?: string;
  place?: string;
  channel: Channel;
}

export interface CheckInResult {
  incident: Incident;
  told: number;
  duplicate: boolean;
}

function openIncidentsOf(db: Db, memberId: number): Incident[] {
  return db.all<Incident>(
    "SELECT * FROM incidents WHERE member_id = ? AND status IN ('open','acknowledged') ORDER BY id DESC",
    memberId,
  );
}

export function checkIn(ctx: Ctx, input: CheckInInput): CheckInResult {
  const { member } = input;
  const place = clean(input.place, 40) || clean(member.home_place, 40) || "home";
  const label = input.channel.toUpperCase();

  if (input.kind === "help") {
    const recent = openIncidentsOf(ctx.db, member.id).find(
      (i) => i.kind === "help" && Date.now() - Date.parse(i.created_at) < 60 * 60 * 1000,
    );
    if (recent) {
      // Same person asking again: update the open request, do not alert everyone twice.
      if (input.need || input.place) {
        ctx.db.run(
          "UPDATE incidents SET need = COALESCE(NULLIF(?, ''), need), place = COALESCE(NULLIF(?, ''), place) WHERE id = ?",
          input.need ?? "",
          clean(input.place, 40),
          recent.id,
        );
      }
      addEvent(ctx, recent.id, "repeat", `Asked for help again via ${label}${input.place ? ` at ${place}` : ""}`);
      ctx.bus.publish({ type: "incident", id: recent.id, summary: "repeat" });
      recordRollCallResponse(ctx, member, "help", recent.id);
      return { incident: incidentById(ctx.db, recent.id)!, told: alertedCount(ctx.db, recent.id), duplicate: true };
    }

    const need = (NEEDS as readonly string[]).includes(input.need ?? "") ? input.need! : "other";
    const inc = createIncident(ctx, { member, kind: "help", need, place, channel: input.channel, status: "open" });
    addEvent(ctx, inc.id, "created", `Help request (${need}) via ${label} at ${place}`);
    escalate(ctx, inc);
    recordRollCallResponse(ctx, member, "help", inc.id);
    return { incident: incidentById(ctx.db, inc.id)!, told: alertedCount(ctx.db, inc.id), duplicate: false };
  }

  if (input.kind === "safe") {
    for (const open of openIncidentsOf(ctx.db, member.id)) {
      resolveIncident(ctx, open, member, "checked in safe");
    }
  }

  const inc = createIncident(ctx, { member, kind: input.kind, place, channel: input.channel, status: "info" });
  addEvent(ctx, inc.id, "created", `${input.kind === "safe" ? "Checked in SAFE" : "Moving"} via ${label} at ${place}`);
  let told = 0;
  for (const c of contactsOf(ctx.db, member.id)) {
    const body =
      input.kind === "safe"
        ? sms.safeInfo({ name: displayName(member), place, at: inc.created_at })
        : sms.movingInfo({ name: displayName(member), place, at: inc.created_at });
    queueSms(ctx, { address: c.guardian_address, personId: c.guardian_id, incidentId: inc.id, purpose: "info", body });
    told++;
  }
  if (told) addEvent(ctx, inc.id, "informed", `Told ${told} family contact(s)`);
  if (input.kind === "safe") recordRollCallResponse(ctx, member, "safe", inc.id);
  ctx.bus.publish({ type: "incident", id: inc.id, summary: input.kind });
  return { incident: incidentById(ctx.db, inc.id)!, told, duplicate: false };
}

function alertedCount(db: Db, incidentId: number): number {
  return db.get<{ n: number }>(
    "SELECT COUNT(DISTINCT person_id) AS n FROM messages WHERE incident_id = ? AND purpose IN ('alert','volunteer-alert')",
    incidentId,
  )!.n;
}

/** People who got an alert or info SMS for this incident. */
function alertedPeople(db: Db, incidentId: number): Person[] {
  return db.all<Person>(
    `SELECT DISTINCT p.* FROM messages m JOIN people p ON p.id = m.person_id
      WHERE m.incident_id = ? AND m.purpose IN ('alert','volunteer-alert')`,
    incidentId,
  );
}

/** Missed roll call: open a "missing" incident and start asking family. */
export function openMissing(ctx: Ctx, member: Person, rollCallId: number): Incident {
  const a = getArea(ctx.db, member.area_id);
  const inc = createIncident(ctx, {
    member,
    kind: "missing",
    place: a ? a.name : "unknown",
    channel: "rollcall",
    rollCallId,
    status: "open",
  });
  addEvent(ctx, inc.id, "created", "No reply to the safety check before the deadline");
  escalate(ctx, inc);
  return incidentById(ctx.db, inc.id)!;
}

/* ── Replies from family and volunteers ───────────────────────────────── */

function canRespond(db: Db, inc: Incident, person: Person): boolean {
  if (contactsOf(db, inc.member_id, true).some((c) => c.guardian_id === person.id)) return true;
  const member = personById(db, inc.member_id);
  if (person.is_volunteer && member && person.area_id === member.area_id) return true;
  return db.get("SELECT 1 FROM messages WHERE incident_id = ? AND person_id = ?", inc.id, person.id) !== undefined;
}

export type ReplyOutcome =
  | { ok: true; incident: Incident; member: Person }
  | { ok: false; reason: "not_found" | "closed" | "already"; by?: string; incident?: Incident };

export function acknowledge(ctx: Ctx, ref: string, person: Person, channel: Channel): ReplyOutcome {
  const inc = incidentByRef(ctx.db, ref);
  if (!inc || !canRespond(ctx.db, inc, person)) return { ok: false, reason: "not_found" };
  const member = personById(ctx.db, inc.member_id)!;
  if (inc.status === "acknowledged") {
    if (inc.acknowledged_by === person.id) return { ok: true, incident: inc, member };
    return { ok: false, reason: "already", by: displayName(personById(ctx.db, inc.acknowledged_by)), incident: inc };
  }
  if (inc.status !== "open") return { ok: false, reason: "closed", incident: inc };

  ctx.db.run(
    "UPDATE incidents SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?, next_escalation_at = NULL WHERE id = ?",
    person.id,
    nowIso(),
    inc.id,
  );
  const who = displayName(person);
  addEvent(ctx, inc.id, "acknowledged", `Acknowledged by ${who} via ${channel.toUpperCase()}`);

  if (inc.kind !== "missing") {
    queueSms(ctx, { address: member.subscriber_id, personId: member.id, incidentId: inc.id, purpose: "ack-to-member", body: sms.ackToMember({ ref: inc.ref, by: who }) });
  }
  for (const other of alertedPeople(ctx.db, inc.id)) {
    if (other.id === person.id) continue;
    queueSms(ctx, { address: other.subscriber_id, personId: other.id, incidentId: inc.id, purpose: "ack-to-others", body: sms.ackToOthers({ ref: inc.ref, by: who, name: displayName(member) }) });
  }
  queueSms(ctx, { address: person.subscriber_id, personId: person.id, incidentId: inc.id, purpose: "ack-confirm", body: sms.ackConfirm({ ref: inc.ref, name: displayName(member) }) });
  ctx.bus.publish({ type: "incident", id: inc.id, summary: "acknowledged" });
  return { ok: true, incident: incidentById(ctx.db, inc.id)!, member };
}

export function resolveIncident(ctx: Ctx, inc: Incident, by: Person | undefined, how: string): void {
  if (inc.status === "resolved" || inc.status === "info") return;
  ctx.db.run(
    "UPDATE incidents SET status = 'resolved', resolved_at = ?, resolution = ?, next_escalation_at = NULL WHERE id = ?",
    nowIso(),
    how,
    inc.id,
  );
  addEvent(ctx, inc.id, "resolved", `Closed: ${how}${by ? ` (${displayName(by)})` : ""}`);
  const member = personById(ctx.db, inc.member_id);
  for (const other of alertedPeople(ctx.db, inc.id)) {
    if (by && other.id === by.id) continue;
    queueSms(ctx, { address: other.subscriber_id, personId: other.id, incidentId: inc.id, purpose: "resolved", body: sms.resolvedToContacts({ ref: inc.ref, name: displayName(member), how }) });
  }
  ctx.bus.publish({ type: "incident", id: inc.id, summary: "resolved" });
}

/** "BIPOD DONE H12" from whoever is handling it, or the member. */
export function markDone(ctx: Ctx, ref: string, person: Person): ReplyOutcome {
  const inc = incidentByRef(ctx.db, ref);
  if (!inc) return { ok: false, reason: "not_found" };
  const member = personById(ctx.db, inc.member_id)!;
  if (inc.member_id !== person.id && !canRespond(ctx.db, inc, person)) return { ok: false, reason: "not_found" };
  if (inc.status === "resolved" || inc.status === "info") return { ok: false, reason: "closed", incident: inc };
  resolveIncident(ctx, inc, person, inc.member_id === person.id ? "is safe now" : `is safe, confirmed by ${displayName(person)}`);
  return { ok: true, incident: incidentById(ctx.db, inc.id)!, member };
}

/** A family member answers a "missing" (or help) alert with "BIPOD SAFE <ref>". */
export function confirmSafeOnBehalf(ctx: Ctx, ref: string, guardian: Person): ReplyOutcome {
  const inc = incidentByRef(ctx.db, ref);
  if (!inc || !canRespond(ctx.db, inc, guardian)) return { ok: false, reason: "not_found" };
  const member = personById(ctx.db, inc.member_id)!;
  if (inc.status === "resolved" || inc.status === "info") return { ok: false, reason: "closed", incident: inc };
  resolveIncident(ctx, inc, guardian, `is safe, confirmed by ${displayName(guardian)}`);
  if (inc.roll_call_id) markTarget(ctx, inc.roll_call_id, member.id, "confirmed_safe");
  return { ok: true, incident: incidentById(ctx.db, inc.id)!, member };
}

/** A family member answers a "missing" alert with "BIPOD HELP <ref>": go straight to volunteers. */
export function reportNeedsHelp(ctx: Ctx, ref: string, guardian: Person): ReplyOutcome {
  const inc = incidentByRef(ctx.db, ref);
  if (!inc || !canRespond(ctx.db, inc, guardian)) return { ok: false, reason: "not_found" };
  const member = personById(ctx.db, inc.member_id)!;
  if (inc.status === "resolved" || inc.status === "info") return { ok: false, reason: "closed", incident: inc };
  const guardians = contactsOf(ctx.db, member.id).length;
  ctx.db.run(
    "UPDATE incidents SET kind = CASE WHEN kind = 'missing' THEN 'help' ELSE kind END, status = 'open', escalation_step = ? WHERE id = ?",
    guardians,
    inc.id,
  );
  addEvent(ctx, inc.id, "family_reports_help", `${displayName(guardian)} says ${displayName(member)} needs help. Alerting volunteers now.`);
  if (inc.roll_call_id) markTarget(ctx, inc.roll_call_id, member.id, "help");
  escalate(ctx, incidentById(ctx.db, inc.id)!);
  return { ok: true, incident: incidentById(ctx.db, inc.id)!, member };
}

/** Latest open incident this person was alerted about (for a bare "BIPOD OK"). */
export function latestAlertFor(db: Db, person: Person): Incident | undefined {
  return db.get<Incident>(
    `SELECT i.* FROM incidents i JOIN messages m ON m.incident_id = i.id
      WHERE m.person_id = ? AND m.purpose IN ('alert','volunteer-alert') AND i.status IN ('open','acknowledged')
      ORDER BY m.id DESC LIMIT 1`,
    person.id,
  );
}
