import type { Ctx } from "../context.ts";
import type { Db } from "../db.ts";
import { displayNumber, telFromTyped } from "../applink/address.ts";
import { clean, shortName, sms } from "./texts.ts";
import { queueSms } from "./outbox.ts";

export interface Area {
  id: string;
  name: string;
  district: string;
  shelter: string;
  lat: number | null;
  lng: number | null;
}

export interface Person {
  id: number;
  subscriber_id: string;
  name: string;
  area_id: string | null;
  home_place: string;
  is_member: number;
  is_volunteer: number;
  subscription_status: string;
  subscription_at: string | null;
  consent_channel: string | null;
  consent_text: string | null;
  consent_at: string | null;
  created_at: string;
}

export interface ContactRow {
  id: number;
  member_id: number;
  guardian_id: number;
  priority: number;
  relation: string;
  status: string;
  guardian_name: string;
  guardian_address: string;
}

export const MAX_CONTACTS = 3;

export function areas(db: Db): Area[] {
  return db.all<Area>("SELECT * FROM areas ORDER BY name");
}

export function area(db: Db, id: string | null | undefined): Area | undefined {
  if (!id) return undefined;
  return db.get<Area>("SELECT * FROM areas WHERE id = ?", id);
}

export function personById(db: Db, id: number | null | undefined): Person | undefined {
  if (id === null || id === undefined) return undefined;
  return db.get<Person>("SELECT * FROM people WHERE id = ?", id);
}

export function personByAddress(db: Db, subscriberId: string): Person | undefined {
  return db.get<Person>("SELECT * FROM people WHERE subscriber_id = ?", subscriberId);
}

/** Find or create a person record for an address. Never subscribes anyone. */
export function ensurePerson(db: Db, subscriberId: string, name = ""): Person {
  const existing = personByAddress(db, subscriberId);
  if (existing) {
    if (name && !existing.name) {
      db.run("UPDATE people SET name = ? WHERE id = ?", clean(name, 30), existing.id);
      return personById(db, existing.id)!;
    }
    return existing;
  }
  const { lastId } = db.run(
    "INSERT INTO people(subscriber_id, name) VALUES (?, ?)",
    subscriberId,
    clean(name, 30),
  );
  return personById(db, lastId)!;
}

export function contactsOf(db: Db, memberId: number, includeDeclined = false): ContactRow[] {
  return db.all<ContactRow>(
    `SELECT c.*, g.name AS guardian_name, g.subscriber_id AS guardian_address
       FROM contacts c JOIN people g ON g.id = c.guardian_id
      WHERE c.member_id = ? ${includeDeclined ? "" : "AND c.status != 'declined'"}
      ORDER BY c.priority`,
    memberId,
  );
}

/** Members this person is a (non-declined) family contact for. */
export function guardedMembers(db: Db, guardianId: number): Person[] {
  return db.all<Person>(
    `SELECT p.* FROM contacts c JOIN people p ON p.id = c.member_id
      WHERE c.guardian_id = ? AND c.status != 'declined'`,
    guardianId,
  );
}

export function volunteersIn(db: Db, areaId: string | null, excludeId?: number): Person[] {
  if (!areaId) return [];
  return db.all<Person>(
    "SELECT * FROM people WHERE is_volunteer = 1 AND area_id = ? AND id != ? AND subscription_status != 'UNREGISTERED'",
    areaId,
    excludeId ?? -1,
  );
}

export function displayName(p: Person | undefined): string {
  if (!p) return "Unknown";
  return shortName(p.name, displayNumber(p.subscriber_id));
}

export type AddContactResult =
  | { ok: true; contact: ContactRow; guardian: Person; created: boolean }
  | { ok: false; reason: "bad_number" | "too_many" | "self" };

/**
 * Add a family contact for a member and send them an invitation SMS.
 * The contact can decline at any time (BIPOD NO / BIPOD STOP).
 */
export function addContact(
  ctx: Ctx,
  member: Person,
  typedNumber: string,
  name = "",
  relation = "",
): AddContactResult {
  const tel = telFromTyped(typedNumber);
  if (!tel) return { ok: false, reason: "bad_number" };
  if (tel === member.subscriber_id) return { ok: false, reason: "self" };

  const guardian = ensurePerson(ctx.db, tel, name);
  const existing = ctx.db.get<ContactRow>(
    "SELECT c.*, '' AS guardian_name, '' AS guardian_address FROM contacts c WHERE member_id = ? AND guardian_id = ?",
    member.id,
    guardian.id,
  );
  if (existing) {
    if (existing.status === "declined") {
      ctx.db.run("UPDATE contacts SET status = 'invited' WHERE id = ?", existing.id);
    }
    const contact = contactsOf(ctx.db, member.id).find((c) => c.guardian_id === guardian.id)!;
    return { ok: true, contact, guardian, created: false };
  }

  const current = contactsOf(ctx.db, member.id);
  if (current.length >= MAX_CONTACTS) return { ok: false, reason: "too_many" };
  const priority = (current.at(-1)?.priority ?? 0) + 1;
  ctx.db.run(
    "INSERT INTO contacts(member_id, guardian_id, priority, relation, status) VALUES (?, ?, ?, ?, 'invited')",
    member.id,
    guardian.id,
    priority,
    clean(relation, 20),
  );
  queueSms(ctx, {
    address: guardian.subscriber_id,
    personId: guardian.id,
    purpose: "invite",
    body: sms.invite({ member: displayName(member), number: displayNumber(member.subscriber_id) }),
  });
  ctx.bus.publish({ type: "people", id: member.id, summary: "contact added" });
  const contact = contactsOf(ctx.db, member.id).find((c) => c.guardian_id === guardian.id)!;
  return { ok: true, contact, guardian, created: true };
}

/** A guardian answered an invitation (BIPOD YES / BIPOD NO). Applies to every pending invite they have. */
export function answerInvites(ctx: Ctx, guardian: Person, accept: boolean): Person[] {
  const pending = ctx.db.all<{ id: number; member_id: number }>(
    "SELECT id, member_id FROM contacts WHERE guardian_id = ? AND status = 'invited'",
    guardian.id,
  );
  const members: Person[] = [];
  for (const row of pending) {
    ctx.db.run("UPDATE contacts SET status = ? WHERE id = ?", accept ? "active" : "declined", row.id);
    const member = personById(ctx.db, row.member_id);
    if (!member) continue;
    members.push(member);
    if (accept) {
      queueSms(ctx, {
        address: member.subscriber_id,
        personId: member.id,
        purpose: "invite-accepted",
        body: sms.inviteAccepted({ guardian: displayName(guardian) }),
      });
    }
  }
  if (pending.length) ctx.bus.publish({ type: "people", id: guardian.id, summary: "invite answered" });
  return members;
}
