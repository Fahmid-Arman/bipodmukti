/**
 * Applink Subscription: opt-in with recorded consent, opt-out, the local
 * mirror fed by subscriber notifications, and the base-size health check.
 */

import { config } from "../config.ts";
import type { Ctx } from "../context.ts";
import { nowIso } from "../db.ts";
import {
  intField,
  queryBaseSize,
  subscribe,
  subscriptionState,
  unsubscribe,
  ServiceNotConfiguredError,
} from "../applink/client.ts";
import { maskTel } from "../applink/address.ts";
import { ensurePerson, personById, type Person } from "./people.ts";
import { cancelQueuedFor } from "./outbox.ts";

/** Exactly what we show before subscribing anyone. Stored with each consent. */
export function consentText(): string {
  return `Join BipodMukti safety alerts (${config.applink.subscriptionTerms}). Your family contacts get an SMS when you check in. Stop any time: ${config.applink.keyword} STOP.`;
}

export interface OptInResult {
  person: Person;
  status: string;
  statusCode: string;
}

/**
 * Record consent, then register the subscriber on Applink. Membership is kept
 * locally even if Applink refuses (for example E1343 during Limited
 * Production), so the console can show exactly why.
 */
export async function optIn(ctx: Ctx, person: Person, channel: string, shownText = consentText()): Promise<OptInResult> {
  ctx.db.run(
    "UPDATE people SET is_member = 1, consent_channel = ?, consent_text = ?, consent_at = ? WHERE id = ?",
    channel,
    shownText,
    nowIso(),
    person.id,
  );
  let status = "PENDING";
  let statusCode = "LOCAL";
  try {
    const res = await subscribe(person.subscriber_id);
    statusCode = res.statusCode;
    status = res.ok ? subscriptionState(res.body.subscriptionStatus) || "REGISTERED" : `ERROR ${res.statusCode}`;
  } catch (err) {
    status = err instanceof ServiceNotConfiguredError ? "LOCAL ONLY" : "ERROR";
    ctx.log.warn({ err: String(err) }, "subscription register not sent");
  }
  ctx.db.run("UPDATE people SET subscription_status = ?, subscription_at = ? WHERE id = ?", status, nowIso(), person.id);
  ctx.bus.publish({ type: "people", id: person.id, summary: `opt-in ${status}` });
  ctx.log.info({ subscriber: maskTel(person.subscriber_id), status, statusCode }, "opt-in");
  return { person: personById(ctx.db, person.id)!, status, statusCode };
}

/** Stop everything for this subscriber: Applink unregister, contacts, queued SMS. */
export async function optOut(ctx: Ctx, person: Person, channel: string): Promise<string> {
  applyOptOutLocally(ctx, person, channel);
  let status = "UNREGISTERED";
  try {
    const res = await unsubscribe(person.subscriber_id);
    if (!res.ok) status = `UNREGISTERED (Applink ${res.statusCode})`;
  } catch (err) {
    ctx.log.warn({ err: String(err) }, "subscription unregister not sent");
  }
  return status;
}

function applyOptOutLocally(ctx: Ctx, person: Person, channel: string): void {
  ctx.db.run(
    "UPDATE people SET is_member = 0, subscription_status = 'UNREGISTERED', subscription_at = ?, consent_channel = ? WHERE id = ?",
    nowIso(),
    `opt-out:${channel}`,
    person.id,
  );
  ctx.db.run("UPDATE contacts SET status = 'declined' WHERE guardian_id = ?", person.id);
  cancelQueuedFor(ctx, person.subscriber_id);
  ctx.bus.publish({ type: "people", id: person.id, summary: "opt-out" });
}

/**
 * Subscriber notification: the authoritative subscription state. Changes we
 * did not start (an opt-out by SMS to Applink, a failed renewal) arrive here.
 */
export function onSubscriberNotification(
  ctx: Ctx,
  n: { subscriberId: string; status: string; frequency?: string; timeStamp?: string },
): void {
  const person = ensurePerson(ctx.db, n.subscriberId);
  const status = subscriptionState(n.status) || "UNKNOWN";
  if (status.startsWith("UNREGISTERED")) {
    applyOptOutLocally(ctx, person, "applink-notification");
    return;
  }
  ctx.db.run("UPDATE people SET subscription_status = ?, subscription_at = ? WHERE id = ?", status, nowIso(), person.id);
  ctx.bus.publish({ type: "people", id: person.id, summary: `notification ${status}` });
}

/** Base size: cheapest Applink call, used as a health check and for the console. */
export async function refreshBaseSize(ctx: Ctx): Promise<{ ok: boolean; baseSize?: number; statusCode: string }> {
  try {
    const res = await queryBaseSize();
    ctx.db.setKv("applink_health", JSON.stringify({ at: nowIso(), statusCode: res.statusCode, statusDetail: res.statusDetail }));
    if (res.ok) {
      const baseSize = intField(res.body.baseSize);
      ctx.db.setKv("base_size", JSON.stringify({ at: nowIso(), baseSize }));
      ctx.bus.publish({ type: "stats", summary: "base size" });
      return { ok: true, baseSize, statusCode: res.statusCode };
    }
    return { ok: false, statusCode: res.statusCode };
  } catch (err) {
    return { ok: false, statusCode: err instanceof ServiceNotConfiguredError ? "NOT_CONFIGURED" : "ERROR" };
  }
}
