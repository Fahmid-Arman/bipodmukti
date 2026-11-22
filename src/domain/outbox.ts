/**
 * Outbound SMS queue.
 *
 * Every SMS is written to the `messages` table first, then sent. Transient
 * Applink failures (E1318, E1341, E160x, timeouts) are retried with backoff;
 * everything else fails fast. Delivery reports update the same row, and a
 * failed alert lets the escalation engine move to the next contact at once.
 */

import type { Ctx } from "../context.ts";
import { nowIso, isoIn } from "../db.ts";
import { sendSms, ServiceNotConfiguredError } from "../applink/client.ts";
import { maskTel } from "../applink/address.ts";

export interface MessageRow {
  id: number;
  incident_id: number | null;
  roll_call_id: number | null;
  person_id: number | null;
  address: string;
  purpose: string;
  body: string;
  status: string;
  request_id: string | null;
  message_id: string | null;
  status_code: string | null;
  status_detail: string | null;
  attempts: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueueSmsInput {
  address: string;
  body: string;
  purpose: string;
  personId?: number | null;
  incidentId?: number | null;
  rollCallId?: number | null;
}

const BACKOFF_SECONDS = [5, 15, 45, 120, 300];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

type FailureHook = (ctx: Ctx, message: MessageRow) => void;
const failureHooks: FailureHook[] = [];

/** Called when a message is known to have failed (send error or delivery report). */
export function onMessageFailed(hook: FailureHook): void {
  failureHooks.push(hook);
}

function notifyFailure(ctx: Ctx, id: number): void {
  const row = ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", id);
  if (!row) return;
  for (const hook of failureHooks) {
    try {
      hook(ctx, row);
    } catch (err) {
      ctx.log.error({ err }, "message failure hook threw");
    }
  }
}

export function queueSms(ctx: Ctx, input: QueueSmsInput): number {
  const { lastId } = ctx.db.run(
    `INSERT INTO messages(incident_id, roll_call_id, person_id, address, purpose, body, status, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    input.incidentId ?? null,
    input.rollCallId ?? null,
    input.personId ?? null,
    input.address,
    input.purpose,
    input.body,
    nowIso(),
  );
  ctx.bus.publish({ type: "message", id: lastId, summary: input.purpose });
  scheduleFlush(ctx);
  return lastId;
}

/** Cancel queued messages to a subscriber who opted out. */
export function cancelQueuedFor(ctx: Ctx, address: string): number {
  return ctx.db.run(
    "UPDATE messages SET status = 'cancelled', updated_at = ? WHERE address = ? AND status = 'queued'",
    nowIso(),
    address,
  ).changes;
}

let flushing = false;
let flushAgain = false;
let flushTimer: NodeJS.Immediate | undefined;

export function scheduleFlush(ctx: Ctx): void {
  if (flushTimer) return;
  flushTimer = setImmediate(() => {
    flushTimer = undefined;
    void flush(ctx);
  });
}

/** Send every due queued message. Safe to call often; only one flush runs at a time. */
export async function flush(ctx: Ctx): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushAgain = false;
      const due = ctx.db.all<MessageRow>(
        "SELECT * FROM messages WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT 50",
        nowIso(),
      );
      for (const msg of due) await sendOne(ctx, msg);
    } while (flushAgain);
  } finally {
    flushing = false;
  }
}

async function sendOne(ctx: Ctx, msg: MessageRow): Promise<void> {
  const attempts = msg.attempts + 1;
  let result;
  try {
    result = await sendSms([msg.address], msg.body);
  } catch (err) {
    const detail = err instanceof ServiceNotConfiguredError ? err.message : String(err);
    ctx.db.run(
      "UPDATE messages SET status = 'failed', attempts = ?, status_code = 'LOCAL', status_detail = ?, updated_at = ? WHERE id = ?",
      attempts,
      detail,
      nowIso(),
      msg.id,
    );
    ctx.log.error({ messageId: msg.id, err: detail }, "sms not sent");
    ctx.bus.publish({ type: "message", id: msg.id, summary: "failed" });
    notifyFailure(ctx, msg.id);
    return;
  }

  // A top-level S1000 can still carry a failed entry for this recipient.
  const entry = result.body.destinationResponses?.[0];
  const entryCode = entry?.statusCode;
  const accepted = result.ok && (!entryCode || entryCode === "S1000");
  const statusCode = accepted ? result.statusCode : entryCode && entryCode !== "S1000" ? entryCode : result.statusCode;
  const statusDetail = accepted ? result.statusDetail : entry?.statusDetail ?? result.statusDetail;

  if (accepted) {
    ctx.db.run(
      `UPDATE messages SET status = 'sent', attempts = ?, request_id = ?, message_id = ?, status_code = ?,
              status_detail = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
      attempts,
      result.requestId ?? null,
      entry?.messageId ?? null,
      statusCode,
      statusDetail,
      nowIso(),
      msg.id,
    );
    ctx.log.info({ messageId: msg.id, to: maskTel(msg.address), requestId: result.requestId, purpose: msg.purpose }, "sms sent");
  } else if (result.retryable && attempts < MAX_ATTEMPTS) {
    ctx.db.run(
      `UPDATE messages SET attempts = ?, status_code = ?, status_detail = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      attempts,
      statusCode,
      statusDetail,
      isoIn(BACKOFF_SECONDS[attempts - 1]),
      nowIso(),
      msg.id,
    );
    ctx.log.warn({ messageId: msg.id, statusCode, attempts }, "sms send will be retried");
  } else {
    ctx.db.run(
      `UPDATE messages SET status = 'failed', attempts = ?, status_code = ?, status_detail = ?, next_attempt_at = NULL,
              updated_at = ? WHERE id = ?`,
      attempts,
      statusCode,
      statusDetail,
      nowIso(),
      msg.id,
    );
    ctx.log.warn({ messageId: msg.id, to: maskTel(msg.address), statusCode }, "sms failed");
    ctx.bus.publish({ type: "message", id: msg.id, summary: "failed" });
    notifyFailure(ctx, msg.id);
    return;
  }
  ctx.bus.publish({ type: "message", id: msg.id, summary: "updated" });
}

const DELIVERED = new Set(["DELIVERED", "DELIVRD"]);
const FAILED = new Set(["EXPIRED", "DELETED", "UNDELIVERABLE", "UNDELIV", "REJECTED", "REJECTD"]);

export function normaliseDeliveryStatus(raw: string): "delivered" | "failed" | "accepted" | "unknown" {
  const s = raw.trim().toUpperCase();
  if (DELIVERED.has(s)) return "delivered";
  if (FAILED.has(s)) return "failed";
  if (s === "ACCEPTED" || s === "ACCEPTD") return "accepted";
  return "unknown";
}

/**
 * Apply an SMS delivery report. Reports can arrive late, twice or never; the
 * row only moves forward (sent -> delivered|failed), never back.
 */
export function applyDeliveryReport(
  ctx: Ctx,
  report: { requestId: string; destinationAddress: string; deliveryStatus: string },
): MessageRow | undefined {
  const candidates = ctx.db.all<MessageRow>("SELECT * FROM messages WHERE request_id = ?", report.requestId);
  const msg =
    candidates.find((m) => m.address === report.destinationAddress) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!msg) return undefined;

  const outcome = normaliseDeliveryStatus(report.deliveryStatus);
  if (outcome === "accepted" || outcome === "unknown") {
    ctx.db.run("UPDATE messages SET status_detail = ?, updated_at = ? WHERE id = ?", report.deliveryStatus, nowIso(), msg.id);
    return msg;
  }
  if (msg.status === "delivered" || msg.status === "failed") return msg;

  ctx.db.run(
    "UPDATE messages SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?",
    outcome,
    report.deliveryStatus,
    nowIso(),
    msg.id,
  );
  ctx.bus.publish({ type: "message", id: msg.id, summary: outcome });
  if (outcome === "failed") notifyFailure(ctx, msg.id);
  return ctx.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", msg.id);
}
