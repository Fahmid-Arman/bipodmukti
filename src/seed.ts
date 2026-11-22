/**
 * Demo data. Every name and number here is invented test data, not a real
 * subscriber. In live Applink mode, replace the numbers with your
 * whitelisted test SIMs (DEMO_MEMBER_NUMBER etc.) before seeding.
 */

import type { Db } from "./db.ts";
import { nowIso } from "./db.ts";
import { telFromTyped } from "./applink/address.ts";

export const AREAS = [
  { id: "rajibpur", name: "Char Rajibpur", district: "Kurigram", shelter: "Rajibpur Govt Primary School", lat: 25.433, lng: 89.792 },
  { id: "gabura", name: "Gabura", district: "Satkhira", shelter: "Gabura Cyclone Shelter", lat: 22.257, lng: 89.304 },
  { id: "tahirpur", name: "Tahirpur", district: "Sunamganj", shelter: "Tahirpur Union Parishad", lat: 25.096, lng: 91.181 },
  { id: "kutubdia", name: "Kutubdia", district: "Cox's Bazar", shelter: "Ali Akbar Dale Shelter", lat: 21.818, lng: 91.858 },
];

function tel(n: string): string {
  const t = telFromTyped(n);
  if (!t) throw new Error(`bad seed number ${n}`);
  return t;
}

interface SeedPerson {
  name: string;
  number: string;
  area?: string;
  home?: string;
  member?: boolean;
  volunteer?: boolean;
  contacts?: { number: string; relation: string; status?: string; name?: string }[];
}

/** Numbers can be overridden so the live demo uses real whitelisted SIMs. */
const env = (k: string, d: string) => process.env[k]?.trim() || d;

export function demoPeople(): SeedPerson[] {
  const member = env("DEMO_MEMBER_NUMBER", "01900000001");
  const son = env("DEMO_FAMILY1_NUMBER", "01900000002");
  const daughter = env("DEMO_FAMILY2_NUMBER", "01400000003");
  const volunteer = env("DEMO_VOLUNTEER_NUMBER", "01900000004");
  return [
    { name: "Rahima Begum", number: member, area: "rajibpur", home: "Char Rajibpur ghat", member: true, contacts: [
      { number: son, relation: "son", status: "active" },
      { number: daughter, relation: "daughter", status: "active" },
    ] },
    { name: "Karim", number: son },
    { name: "Rina", number: daughter },
    { name: "Jamal (CPP volunteer)", number: volunteer, area: "rajibpur", volunteer: true },

    { name: "Abdul Malek", number: "01900000011", area: "rajibpur", home: "Kodalkati char", member: true, contacts: [{ name: "Rafiq", number: "01900000012", relation: "son", status: "active" }] },
    { name: "Nasima", number: "01900000013", area: "rajibpur", home: "Mohonganj", member: true, contacts: [{ name: "Kamal", number: "01900000014", relation: "husband", status: "active" }] },
    { name: "Fatema", number: "01900000015", area: "rajibpur", home: "Bodorpur", member: true, contacts: [{ name: "Babul", number: "01900000016", relation: "brother", status: "invited" }] },
    { name: "Shahid Mia", number: "01900000017", area: "rajibpur", home: "Rajibpur bazar", member: true, contacts: [] },
    { name: "Ayesha", number: "01900000021", area: "gabura", home: "Gabura 9 no ward", member: true, contacts: [{ name: "Sumon", number: "01900000022", relation: "son", status: "active" }] },
    { name: "Harun", number: "01900000023", area: "gabura", home: "Chandipur", member: true, contacts: [{ name: "Salma", number: "01900000024", relation: "wife", status: "active" }] },
    { name: "Selina (CPP volunteer)", number: "01900000025", area: "gabura", volunteer: true },
    { name: "Momena", number: "01900000031", area: "tahirpur", home: "Tahirpur haor", member: true, contacts: [{ name: "Jahid", number: "01900000032", relation: "son", status: "active" }] },
    { name: "Rashed", number: "01900000041", area: "kutubdia", home: "Ali Akbar Dale", member: true, contacts: [{ name: "Nurul", number: "01900000042", relation: "brother", status: "active" }] },
  ];
}

export function seedAreas(db: Db): void {
  for (const a of AREAS) {
    db.run(
      `INSERT INTO areas(id, name, district, shelter, lat, lng) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, district = excluded.district, shelter = excluded.shelter, lat = excluded.lat, lng = excluded.lng`,
      a.id, a.name, a.district, a.shelter, a.lat, a.lng,
    );
  }
}

/** Insert the demo people (idempotent). Returns the member addresses. */
export function seedDemo(db: Db): string[] {
  seedAreas(db);
  const memberAddresses: string[] = [];
  const idFor = (number: string, name = ""): number => {
    const t = tel(number);
    db.run("INSERT OR IGNORE INTO people(subscriber_id, name) VALUES (?, ?)", t, name);
    return db.get<{ id: number }>("SELECT id FROM people WHERE subscriber_id = ?", t)!.id;
  };
  for (const p of demoPeople()) {
    const id = idFor(p.number, p.name);
    db.run(
      `UPDATE people SET name = ?, area_id = COALESCE(?, area_id), home_place = COALESCE(?, home_place),
              is_member = MAX(is_member, ?), is_volunteer = MAX(is_volunteer, ?) WHERE id = ?`,
      p.name, p.area ?? null, p.home ?? null, p.member ? 1 : 0, p.volunteer ? 1 : 0, id,
    );
    if (p.member || p.volunteer) {
      db.run(
        `UPDATE people SET subscription_status = 'REGISTERED', subscription_at = ?, consent_channel = COALESCE(consent_channel, 'demo-seed'),
                consent_text = COALESCE(consent_text, 'Demo test data'), consent_at = COALESCE(consent_at, ?) WHERE id = ?`,
        nowIso(), nowIso(), id,
      );
      memberAddresses.push(tel(p.number));
    }
    (p.contacts ?? []).forEach((c, i) => {
      const gid = idFor(c.number, c.name ?? "");
      db.run(
        "INSERT OR IGNORE INTO contacts(member_id, guardian_id, priority, relation, status) VALUES (?, ?, ?, ?, ?)",
        id, gid, i + 1, c.relation, c.status ?? "active",
      );
    });
  }
  // Family contacts without a name get a readable one.
  db.run("UPDATE people SET name = 'Family of ' || (SELECT m.name FROM contacts c JOIN people m ON m.id = c.member_id WHERE c.guardian_id = people.id LIMIT 1) WHERE name = '' AND id IN (SELECT guardian_id FROM contacts)");
  return memberAddresses;
}
