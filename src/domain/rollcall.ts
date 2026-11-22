/**
 * Safety roll call ("check").
 *
 * After a cyclone signal or flood warning, a coordinator asks every member in
 * an area to check in. Replies come back over SMS or USSD as ordinary
 * check-ins. When the deadline passes, everyone who did not reply gets a
 * "missing" incident, which asks their family first and then local volunteers.
 */

import type { Ctx } from "../context.ts";
import type { Db } from "../db.ts";
import { nowIso, isoIn } from "../db.ts";
import { clean, sms } from "./texts.ts";
import { queueSms } from "./outbox.ts";
import { personById, type Person } from "./people.ts";
import { openMissing } from "./incidents.ts";

export interface RollCall {
  id: number;
  code: string;
  area_id: string | null;
  title: string;
  status: "running" | "closed";
  started_at: string;
  deadline_at: string;
  closed_at: string | null;
}

export type TargetStatus = "pending" | "safe" | "help" | "no_response" | "confirmed_safe";

export interface RollCallSummary extends RollCall {
  area_name: string | null;
  total: number;
  safe: number;
  help: number;
  pending: number;
  no_response: number;
  confirmed_safe: number;
}

export function startRollCall(
  ctx: Ctx,
  input: { areaId: string | null; title: string; minutes: number },
): RollCallSummary {
  const title = clean(input.title, 50) || "Safety check";
  const minutes = Math.max(1, Math.min(24 * 60, Math.round(input.minutes)));
  const members = ctx.db.all<Person>(
    `SELECT * FROM people WHERE is_member = 1 AND subscription_status != 'UNREGISTERED'
       ${input.areaId ? "AND area_id = ?" : ""}`,
    ...(input.areaId ? [input.areaId] : []),
  );

  const id = ctx.db.tx(() => {
    const { lastId } = ctx.db.run(
      "INSERT INTO roll_calls(code, area_id, title, deadline_at) VALUES (?, ?, ?, ?)",
      `TMP-${process.hrtime.bigint()}`,
      input.areaId,
      title,
      isoIn(minutes * 60),
    );
    ctx.db.run("UPDATE roll_calls SET code = ? WHERE id = ?", `C${lastId}`, lastId);
    for (const m of members) {
      ctx.db.run("INSERT INTO roll_call_targets(roll_call_id, person_id) VALUES (?, ?)", lastId, m.id);
    }
    return lastId;
  });

  const rc = rollCallById(ctx.db, id)!;
  for (const m of members) {
    queueSms(ctx, {
      address: m.subscriber_id,
      personId: m.id,
      rollCallId: id,
      purpose: "rollcall",
      body: sms.rollCall({ code: rc.code, title, minutes }),
    });
  }
  ctx.log.info({ rollCall: rc.code, targets: members.length }, "roll call started");
  ctx.bus.publish({ type: "rollcall", id, summary: "started" });
  return summary(ctx.db, id)!;
}

export function rollCallById(db: Db, id: number): RollCall | undefined {
  return db.get<RollCall>("SELECT * FROM roll_calls WHERE id = ?", id);
}

/** A check-in from a member updates every recent roll call they were part of. */
export function recordRollCallResponse(ctx: Ctx, member: Person, kind: "safe" | "help", incidentId: number): void {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const rows = ctx.db.all<{ roll_call_id: number }>(
    `SELECT t.roll_call_id FROM roll_call_targets t JOIN roll_calls r ON r.id = t.roll_call_id
      WHERE t.person_id = ? AND r.started_at >= ? AND t.status IN ('pending','no_response','help')`,
    member.id,
    since,
  );
  for (const r of rows) {
    ctx.db.run(
      "UPDATE roll_call_targets SET status = ?, responded_at = ?, incident_id = ? WHERE roll_call_id = ? AND person_id = ?",
      kind,
      nowIso(),
      incidentId,
      r.roll_call_id,
      member.id,
    );
    ctx.bus.publish({ type: "rollcall", id: r.roll_call_id, summary: kind });
  }
}

export function markTarget(ctx: Ctx, rollCallId: number, personId: number, status: TargetStatus): void {
  ctx.db.run(
    "UPDATE roll_call_targets SET status = ?, responded_at = ? WHERE roll_call_id = ? AND person_id = ?",
    status,
    nowIso(),
    rollCallId,
    personId,
  );
  ctx.bus.publish({ type: "rollcall", id: rollCallId, summary: status });
}

/** Close one roll call: every pending member becomes a "missing" incident. */
export function closeRollCall(ctx: Ctx, id: number): RollCallSummary | undefined {
  const rc = rollCallById(ctx.db, id);
  if (!rc || rc.status === "closed") return summary(ctx.db, id);
  ctx.db.run("UPDATE roll_calls SET status = 'closed', closed_at = ? WHERE id = ?", nowIso(), id);
  const pending = ctx.db.all<{ person_id: number }>(
    "SELECT person_id FROM roll_call_targets WHERE roll_call_id = ? AND status = 'pending'",
    id,
  );
  for (const p of pending) {
    const member = personById(ctx.db, p.person_id);
    if (!member) continue;
    const inc = openMissing(ctx, member, id);
    ctx.db.run(
      "UPDATE roll_call_targets SET status = 'no_response', incident_id = ? WHERE roll_call_id = ? AND person_id = ?",
      inc.id,
      id,
      p.person_id,
    );
  }
  ctx.log.info({ rollCall: rc.code, noResponse: pending.length }, "roll call closed");
  ctx.bus.publish({ type: "rollcall", id, summary: "closed" });
  return summary(ctx.db, id);
}

export function processRollCallDeadlines(ctx: Ctx): number {
  const due = ctx.db.all<{ id: number }>(
    "SELECT id FROM roll_calls WHERE status = 'running' AND deadline_at <= ?",
    nowIso(),
  );
  for (const r of due) closeRollCall(ctx, r.id);
  return due.length;
}

export function summary(db: Db, id: number): RollCallSummary | undefined {
  return db.get<RollCallSummary>(
    `SELECT r.*, a.name AS area_name,
            COUNT(t.person_id) AS total,
            SUM(t.status = 'safe') AS safe,
            SUM(t.status = 'help') AS help,
            SUM(t.status = 'pending') AS pending,
            SUM(t.status = 'no_response') AS no_response,
            SUM(t.status = 'confirmed_safe') AS confirmed_safe
       FROM roll_calls r
       LEFT JOIN areas a ON a.id = r.area_id
       LEFT JOIN roll_call_targets t ON t.roll_call_id = r.id
      WHERE r.id = ?
      GROUP BY r.id`,
    id,
  );
}

export function recentRollCalls(db: Db, limit = 10): RollCallSummary[] {
  const ids = db.all<{ id: number }>("SELECT id FROM roll_calls ORDER BY id DESC LIMIT ?", limit);
  return ids.map((r) => summary(db, r.id)!).filter(Boolean);
}

export function rollCallTargets(db: Db, id: number) {
  return db.all<{ person_id: number; name: string; subscriber_id: string; status: TargetStatus; responded_at: string | null; ref: string | null }>(
    `SELECT t.person_id, p.name, p.subscriber_id, t.status, t.responded_at, i.ref
       FROM roll_call_targets t JOIN people p ON p.id = t.person_id
       LEFT JOIN incidents i ON i.id = t.incident_id
      WHERE t.roll_call_id = ? ORDER BY p.name`,
    id,
  );
}
