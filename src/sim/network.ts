/**
 * Simulated Applink network and virtual basic phones (SIMULATOR_ENABLED=true).
 *
 * Purpose: demo and test the full flow before the Applink app is approved,
 * and let anyone try BipodMukti without a Banglalink SIM.
 *
 *  - /sim/applink/*  answers like Applink: same paths, same request checks
 *    (credentials, required fields, every value a string), same response shapes.
 *  - Virtual phones receive the SMS and USSD screens BipodMukti sends, and
 *    send MO SMS / USSD input to BipodMukti's real callback routes over HTTP,
 *    with the payloads Applink would send. Delivery reports and subscriber
 *    notifications are posted back the same way.
 *
 * Nothing here is used when BipodMukti talks to the real Applink.
 */

import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../config.ts";
import type { Ctx } from "../context.ts";
import { normaliseTel, telFromTyped } from "../applink/address.ts";

interface SimSms {
  id: number;
  at: string;
  direction: "in" | "out";
  peer: string;
  text: string;
  status?: string;
}

interface Phone {
  address: string;
  online: boolean;
  sms: SimSms[];
  ussd: { sessionId: string; screen: string; open: boolean; waiting: boolean } | null;
}

const phones = new Map<string, Phone>();
const registered = new Set<string>();
const otps = new Map<string, { address: string; otp: string; expires: number }>();
export const simBus = new EventEmitter();
simBus.setMaxListeners(200);

let seq = 1;
const nextId = () => seq++;
const platformId = () => `${Date.now()}${randomInt(100000, 999999)}`;
const stamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14);

function phone(address: string): Phone {
  const key = normaliseTel(address);
  let p = phones.get(key);
  if (!p) {
    p = { address: key, online: true, sms: [], ussd: null };
    phones.set(key, p);
  }
  return p;
}

function changed(p: Phone): void {
  simBus.emit("phone", p.address);
}

function selfUrl(path: string): string {
  return `http://127.0.0.1:${config.port}${path}`;
}

async function callback(path: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(selfUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // The app is restarting; a real platform would retry. Nothing to do here.
  }
}

/* ── Request checks, written from the published contract ─────────────── */

interface Spec {
  required: string[];
  optional?: string[];
  arrays?: string[];
  objects?: string[];
}

const SPEC: Record<string, Spec> = {
  "/sms/send": { required: ["version", "message", "destinationAddresses"], optional: ["sourceAddress", "deliveryStatusRequest", "encoding", "binaryHeader"], arrays: ["destinationAddresses"] },
  "/ussd/send": { required: ["version", "message", "sessionId", "ussdOperation", "destinationAddress"], optional: ["encoding"] },
  "/subscription/send": { required: ["subscriberId", "action"] },
  "/subscription/query-base": { required: [] },
  "/subscription/getSubscriberChargingInfo": { required: ["subscriberIds"], arrays: ["subscriberIds"] },
  "/otp/request": { required: ["subscriberId"], optional: ["applicationHash", "applicationMetaData"], objects: ["applicationMetaData"] },
  "/otp/verify": { required: ["referenceNo", "otp"] },
};

function check(path: string, contentType: string | undefined, body: unknown): { code: string; detail: string } | null {
  const spec = SPEC[path];
  if (!spec) return { code: "E1315", detail: `${path} is not a service` };
  if (!/application\/json/i.test(contentType ?? "")) return { code: "E1312", detail: "Content-Type must be application/json" };
  if (!body || typeof body !== "object" || Array.isArray(body)) return { code: "E1312", detail: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (b.applicationId !== config.applink.applicationId || b.password !== config.applink.password) {
    return { code: "E1313", detail: "Authentication failed" };
  }
  const allowed = new Set(["applicationId", "password", ...spec.required, ...(spec.optional ?? [])]);
  for (const key of Object.keys(b)) {
    if (!allowed.has(key)) return { code: "E1312", detail: `Unexpected field ${key}` };
    const v = b[key];
    if (spec.arrays?.includes(key)) {
      if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string")) return { code: "E1312", detail: `${key} must be a non-empty array of strings` };
    } else if (spec.objects?.includes(key)) {
      if (!v || typeof v !== "object" || Array.isArray(v) || Object.values(v).some((x) => typeof x !== "string")) return { code: "E1312", detail: `${key} must be an object of strings` };
    } else if (typeof v !== "string") {
      return { code: "E1312", detail: `${key} must be a string` };
    }
  }
  for (const key of spec.required) if (b[key] === undefined || b[key] === "") return { code: "E1312", detail: `Missing ${key}` };
  const addresses = [
    ...(Array.isArray(b.destinationAddresses) ? b.destinationAddresses : []),
    ...(Array.isArray(b.subscriberIds) ? b.subscriberIds : []),
    ...(typeof b.destinationAddress === "string" ? [b.destinationAddress] : []),
    ...(typeof b.subscriberId === "string" ? [b.subscriberId] : []),
  ] as string[];
  for (const a of addresses) if (!/^tel:\S+$/.test(a)) return { code: "E1325", detail: `Invalid address ${a}` };
  return null;
}

function fail(reply: FastifyReply, code: string, detail: string) {
  return reply.send({ statusCode: code, statusDetail: detail });
}

/* ── Routes ───────────────────────────────────────────────────────────── */

export function registerSimulator(app: FastifyInstance, ctx: Ctx): void {
  const appId = config.applink.applicationId;
  const shortcode = config.applink.shortcode;

  app.post<{ Params: { "*": string } }>("/sim/applink/*", async (req, reply) => {
    const path = `/${req.params["*"]}`;
    const problem = check(path, req.headers["content-type"], req.body);
    if (problem) return fail(reply, problem.code, problem.detail);
    const b = req.body as Record<string, string & string[] & Record<string, string>>;

    if (path === "/sms/send") {
      const targets: string[] = b.destinationAddresses.includes("tel:all") ? [...registered] : b.destinationAddresses;
      const requestId = platformId();
      const responses = targets.map((address: string) => {
        const p = phone(address);
        const msg: SimSms = { id: nextId(), at: new Date().toISOString(), direction: "in", peer: shortcode, text: b.message, status: p.online ? "delivered" : "pending" };
        if (p.online) p.sms.push(msg);
        changed(p);
        if (b.deliveryStatusRequest === "1") {
          setTimeout(() => {
            void callback("/api/applink/sms/report", {
              destinationAddress: p.address,
              timeStamp: stamp(),
              requestId,
              deliveryStatus: p.online ? "DELIVERED" : "UNDELIVERABLE",
            });
          }, p.online ? 700 : 1500);
        }
        return { timeStamp: stamp(), address: p.address, messageId: platformId(), statusCode: "S1000", statusDetail: "Success" };
      });
      return { version: "1.0", requestId, destinationResponses: responses, statusCode: "S1000", statusDetail: "Success." };
    }

    if (path === "/ussd/send") {
      const p = phone(b.destinationAddress);
      if (!p.ussd || p.ussd.sessionId !== b.sessionId) return fail(reply, "E1312", "No open USSD session with that sessionId");
      p.ussd.screen = b.message;
      p.ussd.waiting = false;
      p.ussd.open = b.ussdOperation !== "mt-fin";
      changed(p);
      return { version: "1.0", requestId: platformId(), timeStamp: stamp(), statusCode: "S1000", statusDetail: "Success." };
    }

    if (path === "/subscription/send") {
      const address = normaliseTel(b.subscriberId);
      const on = b.action === "1";
      if (b.action !== "1" && b.action !== "0") return fail(reply, "E1312", "action must be \"1\" or \"0\"");
      const was = registered.has(address);
      if (on) registered.add(address);
      else registered.delete(address);
      if (was !== on) {
        setTimeout(() => void callback("/api/applink/subscription/notify", {
          timeStamp: stamp(), version: "1.0", applicationId: appId, password: config.applink.password,
          subscriberId: address, frequency: "monthly", status: on ? "REGISTERED" : "UNREGISTERED",
        }), 400);
      }
      return { version: "1.0", statusCode: "S1000", statusDetail: on ? "Success." : was ? "Success." : "not registered", subscriptionStatus: on ? "REGISTERED" : "UNREGISTERED." };
    }

    if (path === "/subscription/query-base") {
      return { baseSize: String(registered.size), version: "1.0", statusCode: "S1000", statusDetail: "Success." };
    }

    if (path === "/subscription/getSubscriberChargingInfo") {
      if (b.subscriberIds.length > 10) return fail(reply, "E1312", "At most 10 subscriberIds");
      return {
        version: "1.0",
        destinationResponses: b.subscriberIds.map((id: string) => ({
          subscriberId: id,
          subscriptionStatus: registered.has(normaliseTel(id)) ? "REGISTERED" : "UNREGISTERED",
          numberType: "prepaid",
          statusCode: "S1000",
          statusDetail: "Request was successfully processed",
        })),
        statusCode: "S1000",
        statusDetail: "Success.",
      };
    }

    if (path === "/otp/request") {
      const address = normaliseTel(b.subscriberId);
      const otp = String(randomInt(100000, 999999));
      const referenceNo = `${Date.now()}${randomInt(1000000, 9999999)}`;
      otps.set(referenceNo, { address, otp, expires: Date.now() + 5 * 60_000 });
      const p = phone(address);
      if (p.online) {
        p.sms.push({ id: nextId(), at: new Date().toISOString(), direction: "in", peer: "OTP", text: `Your verification code is ${otp}. It is valid for 5 minutes.` });
        changed(p);
      }
      return { version: "1.0", referenceNo, statusCode: "S1000", statusDetail: "Success" };
    }

    if (path === "/otp/verify") {
      const entry = otps.get(b.referenceNo);
      if (!entry) return fail(reply, "E1855", "Invalid reference number.");
      if (entry.expires < Date.now()) return fail(reply, "E1851", "The OTP request has expired.");
      if (entry.otp !== b.otp) return fail(reply, "E1850", "Invalid OTP.");
      otps.delete(b.referenceNo);
      if (!registered.has(entry.address)) {
        registered.add(entry.address);
        setTimeout(() => void callback("/api/applink/subscription/notify", {
          timeStamp: stamp(), version: "1.0", applicationId: appId, password: config.applink.password,
          subscriberId: entry.address, frequency: "monthly", status: "REGISTERED",
        }), 400);
      }
      return { version: "1.0", statusCode: "S1000", subscriptionStatus: "REGISTERED", statusDetail: "Success", subscriberId: entry.address };
    }

    return fail(reply, "E1315", "Unknown service");
  });

  /* ── Virtual phones ───────────────────────────────────────────────── */

  const view = (p: Phone) => {
    const person = ctx.db.get<{ name: string; is_member: number; is_volunteer: number }>(
      "SELECT name, is_member, is_volunteer FROM people WHERE subscriber_id = ?",
      p.address,
    );
    return {
      address: p.address,
      local: p.address.startsWith("tel:880") ? `0${p.address.slice(7)}` : p.address,
      name: person?.name ?? "",
      role: person ? (person.is_volunteer ? "volunteer" : person.is_member ? "member" : "family") : "new",
      online: p.online,
      registered: registered.has(p.address),
      sms: p.sms.slice(-30),
      ussd: p.ussd,
    };
  };

  app.get("/sim/phones", async () => {
    const people = ctx.db.all<{ subscriber_id: string }>(
      "SELECT subscriber_id FROM people ORDER BY is_volunteer, is_member DESC, id LIMIT 40",
    );
    for (const p of people) phone(p.subscriber_id);
    return [...phones.values()].map(view);
  });

  app.get<{ Params: { address: string } }>("/sim/phones/:address", async (req) => view(phone(req.params.address)));

  app.post<{ Body: { number?: string } }>("/sim/phones", async (req, reply) => {
    const tel = telFromTyped(String(req.body?.number ?? ""));
    if (!tel) return reply.code(400).send({ error: "Enter 01XXXXXXXXX" });
    const p = phone(tel);
    changed(p);
    return view(p);
  });

  app.post<{ Params: { address: string }; Body: { online?: boolean } }>("/sim/phones/:address/power", async (req) => {
    const p = phone(req.params.address);
    p.online = Boolean(req.body?.online);
    if (!p.online && p.ussd) p.ussd = null;
    changed(p);
    return view(p);
  });

  app.post<{ Params: { address: string }; Body: { text?: string } }>("/sim/phones/:address/sms", async (req, reply) => {
    const p = phone(req.params.address);
    const text = String(req.body?.text ?? "").slice(0, 300);
    if (!text.trim()) return reply.code(400).send({ error: "empty message" });
    if (!p.online) return reply.code(409).send({ error: "Phone is switched off" });
    p.sms.push({ id: nextId(), at: new Date().toISOString(), direction: "out", peer: shortcode, text });
    changed(p);
    void callback("/api/applink/sms/receive", {
      version: "1.0",
      applicationId: appId,
      sourceAddress: p.address,
      message: text,
      requestId: platformId(),
      encoding: "0",
    });
    return view(p);
  });

  app.post<{ Params: { address: string }; Body: { text?: string; dial?: boolean } }>("/sim/phones/:address/ussd", async (req, reply) => {
    const p = phone(req.params.address);
    if (!p.online) return reply.code(409).send({ error: "Phone is switched off" });
    const text = String(req.body?.text ?? "").slice(0, 60);
    let op: "mo-init" | "mo-cont";
    if (req.body?.dial || !p.ussd?.open) {
      p.ussd = { sessionId: platformId(), screen: "Running USSD code...", open: true, waiting: true };
      op = "mo-init";
    } else {
      p.ussd.waiting = true;
      op = "mo-cont";
    }
    changed(p);
    void callback("/api/applink/ussd/receive", {
      version: "1.0",
      applicationId: appId,
      message: op === "mo-init" ? text || config.applink.ussdCode : text,
      requestId: platformId(),
      sessionId: p.ussd.sessionId,
      ussdOperation: op,
      sourceAddress: p.address,
      vlrAddress: p.address,
      encoding: "440",
    });
    return view(p);
  });

  app.post<{ Params: { address: string } }>("/sim/phones/:address/ussd/close", async (req) => {
    const p = phone(req.params.address);
    p.ussd = null;
    changed(p);
    return view(p);
  });

  app.post<{ Params: { address: string } }>("/sim/phones/:address/clear", async (req) => {
    const p = phone(req.params.address);
    p.sms = [];
    changed(p);
    return view(p);
  });

  app.get("/sim/stream", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    reply.raw.write("retry: 3000\n\n");
    const send = (address: string) => reply.raw.write(`data: ${JSON.stringify(view(phone(address)))}\n\n`);
    const beat = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);
    simBus.on("phone", send);
    req.raw.on("close", () => {
      clearInterval(beat);
      simBus.off("phone", send);
    });
  });
}

/** Mark seeded members as already subscribed in the simulated platform. */
export function simMarkRegistered(addresses: string[]): void {
  for (const a of addresses) registered.add(normaliseTel(a));
}
