/**
 * Applink -> BipodMukti callbacks.
 *
 * Every handler acknowledges with S1000 first and works afterwards, because
 * USSD sessions time out in seconds. Each one checks applicationId, drops
 * duplicates (Applink can deliver twice), and never logs a raw payload: the
 * subscriber notification carries our API password.
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config.ts";
import type { Ctx } from "../context.ts";
import { maskTel, normaliseTel } from "../applink/address.ts";
import { sendUssd } from "../applink/client.ts";
import { handleIncomingSms, parseSms } from "../domain/sms.ts";
import { handleUssd } from "../domain/ussd.ts";
import { applyDeliveryReport } from "../domain/outbox.ts";
import { onSubscriberNotification } from "../domain/subscriptions.ts";

const ACK = { statusCode: "S1000", statusDetail: "Success" };

type Body = Record<string, unknown>;

function s(body: Body, key: string): string {
  const v = body[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function logCallback(ctx: Ctx, kind: string, summary: string): void {
  ctx.db.run("INSERT INTO callbacks_log(kind, summary) VALUES (?, ?)", kind, summary);
  ctx.bus.publish({ type: "callback", summary: kind });
}

function later(ctx: Ctx, what: string, fn: () => Promise<void> | void): void {
  setImmediate(() => {
    Promise.resolve()
      .then(fn)
      .catch((err: unknown) => ctx.log.error({ err: err instanceof Error ? err.message : String(err), what }, "callback processing failed"));
  });
}

export function registerCallbacks(app: FastifyInstance, ctx: Ctx): void {
  const appId = config.applink.applicationId;

  app.post("/api/applink/sms/receive", async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    reply.send(ACK);
    later(ctx, "sms-mo", async () => {
      if (s(body, "applicationId") !== appId) return logCallback(ctx, "sms-mo rejected", "applicationId mismatch");
      const requestId = s(body, "requestId");
      const source = s(body, "sourceAddress");
      const message = s(body, "message");
      if (!requestId || !source) return logCallback(ctx, "sms-mo rejected", "missing requestId or sourceAddress");
      if (!ctx.db.firstTime(`mo:${requestId}`)) return logCallback(ctx, "sms-mo duplicate", `requestId ${requestId} ignored`);
      const address = normaliseTel(source);
      logCallback(ctx, "sms-mo", `SMS from ${maskTel(address)}: ${parseSms(message).kind.toUpperCase()}`);
      await handleIncomingSms(ctx, address, message);
    });
    return reply;
  });

  app.post("/api/applink/sms/report", async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    reply.send(ACK);
    later(ctx, "sms-report", () => {
      const requestId = s(body, "requestId");
      const status = s(body, "deliveryStatus");
      const destination = normaliseTel(s(body, "destinationAddress"));
      if (!requestId || !status) return logCallback(ctx, "sms-report rejected", "missing requestId or deliveryStatus");
      if (!ctx.db.firstTime(`dr:${requestId}:${destination}:${status}`)) return;
      const msg = applyDeliveryReport(ctx, { requestId, destinationAddress: destination, deliveryStatus: status });
      logCallback(ctx, "sms-report", `${status} for ${maskTel(destination)}${msg ? "" : " (unknown requestId)"}`);
    });
    return reply;
  });

  app.post("/api/applink/ussd/receive", async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    reply.send(ACK);
    later(ctx, "ussd", async () => {
      if (s(body, "applicationId") !== appId) return logCallback(ctx, "ussd rejected", "applicationId mismatch");
      const requestId = s(body, "requestId");
      const sessionId = s(body, "sessionId");
      const source = s(body, "sourceAddress");
      const op = s(body, "ussdOperation");
      if (!sessionId || !source) return logCallback(ctx, "ussd rejected", "missing sessionId or sourceAddress");
      if (requestId && !ctx.db.firstTime(`ussd:${requestId}`)) return;
      logCallback(ctx, "ussd", `${op} from ${maskTel(normaliseTel(source))}`);
      const screen = await handleUssd(ctx, { sessionId, sourceAddress: normaliseTel(source), message: s(body, "message"), ussdOperation: op });
      // Echo the platform's sessionId and the sourceAddress exactly as received.
      const res = await sendUssd(sessionId, source, screen.text, screen.op);
      if (!res.ok) ctx.log.warn({ statusCode: res.statusCode, sessionId }, "ussd screen not accepted");
    });
    return reply;
  });

  // BipodMukti does not charge through CaaS. If a charging notification ever
  // arrives, acknowledge it (so the platform does not redeliver) and log it.
  app.post("/api/applink/caas/charging-notification", async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    reply.send(ACK);
    later(ctx, "caas", () => {
      const trx = s(body, "externalTrxId");
      if (trx && !ctx.db.firstTime(`caas:${trx}:${s(body, "statusCode")}`)) return;
      logCallback(ctx, "caas (unused)", `charging notification ${s(body, "statusCode") || "-"} for ${trx || "unknown trx"}, ignored: CaaS is not used`);
    });
    return reply;
  });

  app.post("/api/applink/subscription/notify", async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    reply.send(ACK);
    later(ctx, "subscription-notify", () => {
      if (s(body, "applicationId") !== appId) return logCallback(ctx, "subscription rejected", "applicationId mismatch");
      const password = s(body, "password");
      if (password && !sameSecret(password, config.applink.password)) {
        return logCallback(ctx, "subscription rejected", "password mismatch");
      }
      const subscriberId = s(body, "subscriberId");
      const status = s(body, "status");
      const timeStamp = s(body, "timeStamp");
      if (!subscriberId || !status) return logCallback(ctx, "subscription rejected", "missing subscriberId or status");
      if (!ctx.db.firstTime(`sub:${subscriberId}:${status}:${timeStamp}`)) return;
      logCallback(ctx, "subscription", `${status} for ${maskTel(subscriberId)} (${s(body, "frequency") || "-"})`);
      onSubscriberNotification(ctx, { subscriberId: normaliseTel(subscriberId), status, frequency: s(body, "frequency"), timeStamp });
    });
    return reply;
  });
}
