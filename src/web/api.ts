/**
 * Coordinator console API, live event stream, and public web sign-up (OTP).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config, enabledServices } from "../config.ts";
import type { Ctx } from "../context.ts";
import type { Db } from "../db.ts";
import { nowIso } from "../db.ts";
import { displayNumber, maskTel, telFromTyped } from "../applink/address.ts";
import { requestOtp, verifyOtp, subscriptionState, ServiceNotConfiguredError } from "../applink/client.ts";
import { explain } from "../applink/status.ts";
import { addContact, areas, contactsOf, ensurePerson, personById, type Person } from "../domain/people.ts";
import { addEvent, escalate, incidentById, resolveIncident, type Incident } from "../domain/incidents.ts";
import { closeRollCall, recentRollCalls, rollCallTargets, startRollCall } from "../domain/rollcall.ts";
import { consentText, refreshBaseSize } from "../domain/subscriptions.ts";
import { clean } from "../domain/texts.ts";

/* ── helpers ──────────────────────────────────────────────────────────── */

function bad(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

/** Sliding-window limiter stored in SQLite. Returns false when over the limit. */
export function allow(db: Db, key: string, limit: number, windowMs: number): boolean {
  const since = Date.now() - windowMs;
  const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rate_limits WHERE key = ? AND at > ?", key, since)!.n;
  if (n >= limit) return false;
  db.run("INSERT INTO rate_limits(key, at) VALUES (?, ?)", key, Date.now());
  return true;
}

function consoleAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const password = config.dashboardPassword;
  if (!password) return true;
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const given = decoded.slice(decoded.indexOf(":") + 1);
    const a = Buffer.from(given);
    const b = Buffer.from(password);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  reply.header("WWW-Authenticate", 'Basic realm="BipodMukti console"').code(401).send({ error: "login required" });
  return false;
}

function personView(p: Person | undefined) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name || displayNumber(p.subscriber_id),
    number: maskTel(p.subscriber_id),
    areaId: p.area_id,
    isMember: p.is_member === 1,
    isVolunteer: p.is_volunteer === 1,
    subscription: p.subscription_status,
  };
}

function kvJson(db: Db, key: string): unknown {
  const v = db.getKv(key);
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

/* ── views ────────────────────────────────────────────────────────────── */

export function overview(ctx: Ctx) {
  const db = ctx.db;
  const today = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const n = (sql: string, ...p: (string | number)[]) => db.get<{ n: number }>(sql, ...p)!.n;
  const areaRows = areas(db).map((a) => ({
    ...a,
    members: n("SELECT COUNT(*) AS n FROM people WHERE is_member = 1 AND area_id = ?", a.id),
    open: n(
      "SELECT COUNT(*) AS n FROM incidents i JOIN people p ON p.id = i.member_id WHERE p.area_id = ? AND i.status IN ('open','acknowledged')",
      a.id,
    ),
    safe24h: n(
      "SELECT COUNT(DISTINCT member_id) AS n FROM incidents i JOIN people p ON p.id = i.member_id WHERE p.area_id = ? AND i.kind = 'safe' AND i.created_at > ?",
      a.id,
      today,
    ),
  }));
  return {
    mode: config.simulator ? "simulator" : "applink",
    services: enabledServices(),
    keyword: config.applink.keyword,
    shortcode: config.applink.shortcode,
    ussdCode: config.applink.ussdCode,
    ackTimeoutSeconds: config.escalation.ackTimeoutSeconds,
    stats: {
      members: n("SELECT COUNT(*) AS n FROM people WHERE is_member = 1"),
      contacts: n("SELECT COUNT(DISTINCT guardian_id) AS n FROM contacts WHERE status != 'declined'"),
      volunteers: n("SELECT COUNT(*) AS n FROM people WHERE is_volunteer = 1"),
      open: n("SELECT COUNT(*) AS n FROM incidents WHERE status = 'open'"),
      acknowledged: n("SELECT COUNT(*) AS n FROM incidents WHERE status = 'acknowledged'"),
      needsCoordinator: n("SELECT COUNT(*) AS n FROM incidents WHERE status = 'open' AND next_escalation_at IS NULL"),
      checkIns24h: n("SELECT COUNT(*) AS n FROM incidents WHERE created_at > ? AND channel != 'rollcall'", today),
      smsSent: n("SELECT COUNT(*) AS n FROM messages WHERE status IN ('sent','delivered','failed') AND attempts > 0"),
      smsDelivered: n("SELECT COUNT(*) AS n FROM messages WHERE status = 'delivered'"),
      smsFailed: n("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed'"),
      applinkCalls: n("SELECT COUNT(*) AS n FROM api_calls"),
      callbacks: n("SELECT COUNT(*) AS n FROM callbacks_log"),
    },
    baseSize: kvJson(db, "base_size"),
    health: kvJson(db, "applink_health"),
    areas: areaRows,
  };
}

export function incidentView(db: Db, inc: Incident) {
  const member = personById(db, inc.member_id);
  const events = db.all<{ at: string; type: string; detail: string }>(
    "SELECT at, type, detail FROM incident_events WHERE incident_id = ? ORDER BY id",
    inc.id,
  );
  const messages = db
    .all<{ id: number; person_id: number | null; address: string; purpose: string; status: string; status_code: string | null; status_detail: string | null; created_at: string; updated_at: string; request_id: string | null; name: string | null }>(
      `SELECT m.id, m.person_id, m.address, m.purpose, m.status, m.status_code, m.status_detail, m.created_at, m.updated_at, m.request_id, p.name
         FROM messages m LEFT JOIN people p ON p.id = m.person_id WHERE m.incident_id = ? ORDER BY m.id`,
      inc.id,
    )
    .map((m) => ({
      id: m.id,
      to: m.name || maskTel(m.address),
      number: maskTel(m.address),
      purpose: m.purpose,
      status: m.status,
      statusCode: m.status_code,
      statusDetail: m.status_detail,
      requestId: m.request_id,
      at: m.updated_at,
    }));
  const areaRow = member?.area_id ? db.get<{ name: string; district: string }>("SELECT name, district FROM areas WHERE id = ?", member.area_id) : undefined;
  return {
    id: inc.id,
    ref: inc.ref,
    kind: inc.kind,
    need: inc.need,
    place: inc.place,
    channel: inc.channel,
    status: inc.status,
    needsCoordinator: inc.status === "open" && inc.next_escalation_at === null,
    nextEscalationAt: inc.next_escalation_at,
    escalationStep: inc.escalation_step,
    createdAt: inc.created_at,
    acknowledgedAt: inc.acknowledged_at,
    acknowledgedBy: personView(personById(db, inc.acknowledged_by)),
    resolvedAt: inc.resolved_at,
    resolution: inc.resolution,
    member: personView(member),
    area: areaRow ? `${areaRow.name}, ${areaRow.district}` : null,
    contacts: member ? contactsOf(db, member.id).map((c) => ({ name: c.guardian_name || maskTel(c.guardian_address), relation: c.relation, status: c.status, priority: c.priority })) : [],
    events,
    messages,
  };
}

function incidentList(db: Db, limit = 40) {
  const rows = db.all<Incident>(
    `SELECT * FROM incidents
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, id DESC
      LIMIT ?`,
    limit,
  );
  return rows.map((r) => incidentView(db, r));
}

/* ── routes ───────────────────────────────────────────────────────────── */

export function registerApi(app: FastifyInstance, ctx: Ctx): void {
  const db = ctx.db;

  // Public info for the landing and join pages. No secrets, no personal data.
  app.get("/api/public/info", async () => ({
    mode: config.simulator ? "simulator" : "applink",
    keyword: config.applink.keyword,
    shortcode: config.applink.shortcode,
    ussdCode: config.applink.ussdCode,
    terms: config.applink.subscriptionTerms,
    consentText: consentText(),
    areas: areas(db).map((a) => ({ id: a.id, name: a.name, district: a.district })),
  }));

  /* console (guarded when DASHBOARD_PASSWORD is set) */
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/console") || req.url === "/console" || req.url.startsWith("/console.html")) {
      if (!consoleAuth(req, reply)) return reply;
    }
  });

  app.get("/api/console/overview", async () => overview(ctx));

  app.get("/api/console/incidents", async () => incidentList(db));

  app.get<{ Params: { id: string } }>("/api/console/incidents/:id", async (req, reply) => {
    const inc = incidentById(db, Number(req.params.id));
    return inc ? incidentView(db, inc) : bad(reply, 404, "not found");
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>("/api/console/incidents/:id/resolve", async (req, reply) => {
    const inc = incidentById(db, Number(req.params.id));
    if (!inc) return bad(reply, 404, "not found");
    resolveIncident(ctx, inc, undefined, clean(req.body?.note, 60) || "closed by coordinator");
    return incidentView(db, incidentById(db, inc.id)!);
  });

  app.post<{ Params: { id: string } }>("/api/console/incidents/:id/escalate", async (req, reply) => {
    const inc = incidentById(db, Number(req.params.id));
    if (!inc || inc.status !== "open") return bad(reply, 400, "only open requests can be escalated");
    addEvent(ctx, inc.id, "manual_escalation", "Coordinator moved this to the next contact");
    escalate(ctx, inc);
    return incidentView(db, incidentById(db, inc.id)!);
  });

  app.get("/api/console/rollcalls", async () => {
    const list = recentRollCalls(db, 8);
    return list.map((r) => ({ ...r, targets: rollCallTargets(db, r.id).map((t) => ({ ...t, number: maskTel(t.subscriber_id), subscriber_id: undefined })) }));
  });

  app.post<{ Body: { areaId?: string | null; title?: string; minutes?: number } }>("/api/console/rollcalls", async (req, reply) => {
    const areaId = req.body?.areaId || null;
    if (areaId && !areas(db).some((a) => a.id === areaId)) return bad(reply, 400, "unknown area");
    const minutes = Number(req.body?.minutes ?? config.rollCall.defaultDeadlineMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return bad(reply, 400, "minutes must be positive");
    return startRollCall(ctx, { areaId, title: req.body?.title ?? "Safety check", minutes });
  });

  app.post<{ Params: { id: string } }>("/api/console/rollcalls/:id/close", async (req, reply) => {
    const out = closeRollCall(ctx, Number(req.params.id));
    return out ?? bad(reply, 404, "not found");
  });

  app.get("/api/console/people", async () => {
    const members = db.all<Person>("SELECT * FROM people WHERE is_member = 1 OR is_volunteer = 1 ORDER BY is_volunteer, name");
    return members.map((m) => ({
      ...personView(m),
      contacts: contactsOf(db, m.id).map((c) => ({ name: c.guardian_name || maskTel(c.guardian_address), number: maskTel(c.guardian_address), relation: c.relation, status: c.status })),
      consent: m.consent_channel ? { channel: m.consent_channel, at: m.consent_at } : null,
    }));
  });

  app.get("/api/console/activity", async () => ({
    applink: db.all("SELECT at, service, status_code AS statusCode, status_detail AS statusDetail, request_id AS requestId, duration_ms AS ms, ok, summary FROM api_calls ORDER BY id DESC LIMIT 40")
      .map((r) => ({ ...r, ok: (r as { ok: number }).ok === 1, meaning: explain((r as { statusCode: string }).statusCode) })),
    callbacks: db.all("SELECT at, kind, summary FROM callbacks_log ORDER BY id DESC LIMIT 40"),
  }));

  app.post("/api/console/health", async () => refreshBaseSize(ctx));

  // Live updates for the console (Server-Sent Events).
  app.get("/api/console/stream", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 3000\n\n");
    const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const beat = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);
    ctx.bus.on("console", send);
    req.raw.on("close", () => {
      clearInterval(beat);
      ctx.bus.off("console", send);
    });
  });

  /* ── Web sign-up with Applink OTP ─────────────────────────────────── */

  app.post<{ Body: { name?: string; number?: string; areaId?: string } }>("/api/join/start", async (req, reply) => {
    const tel = telFromTyped(String(req.body?.number ?? ""));
    if (!tel) return bad(reply, 400, "Enter a Bangladesh mobile number like 019XXXXXXXX.");
    const areaId = req.body?.areaId && areas(db).some((a) => a.id === req.body?.areaId) ? req.body.areaId : null;
    if (!allow(db, `otp-ip:${req.ip}`, 10, 3600_000) || !allow(db, `otp-num:${tel}`, 3, 900_000)) {
      return bad(reply, 429, "Too many codes requested. Please wait 15 minutes.");
    }
    let res;
    try {
      res = await requestOtp(tel, {
        client: "WEBAPP",
        device: "Browser",
        os: clean(String(req.headers["user-agent"] ?? "web"), 40) || "web",
        appCode: `${config.publicBaseUrl}/join`,
      });
    } catch (err) {
      if (err instanceof ServiceNotConfiguredError) return bad(reply, 503, "Web sign-up is not enabled yet. Dial the USSD code instead.");
      throw err;
    }
    if (!res.ok || !res.body.referenceNo) {
      return bad(reply, 502, `Could not send the code (${res.statusCode}: ${explain(res.statusCode)}).`);
    }
    const token = randomBytes(18).toString("base64url");
    db.run(
      "INSERT INTO otp_sessions(token, address, reference_no, name, area_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      token,
      tel,
      String(res.body.referenceNo),
      clean(req.body?.name, 30),
      areaId,
      Date.now() + 5 * 60_000,
    );
    return { token, sentTo: maskTel(tel), expiresInSeconds: 300 };
  });

  app.post<{ Body: { token?: string; otp?: string } }>("/api/join/verify", async (req, reply) => {
    const row = db.get<{ token: string; address: string; reference_no: string; name: string; area_id: string | null; attempts: number; expires_at: number; verified_at: string | null }>(
      "SELECT * FROM otp_sessions WHERE token = ?",
      String(req.body?.token ?? ""),
    );
    if (!row || row.verified_at) return bad(reply, 400, "This sign-up has expired. Start again.");
    if (row.expires_at < Date.now()) return bad(reply, 400, "The code expired. Request a new one.");
    if (row.attempts >= 5) return bad(reply, 429, "Too many wrong codes. Request a new one.");
    const otp = String(req.body?.otp ?? "").replace(/\D/g, "");
    if (otp.length < 4 || otp.length > 8) return bad(reply, 400, "Enter the code from the SMS.");
    db.run("UPDATE otp_sessions SET attempts = attempts + 1 WHERE token = ?", row.token);

    const res = await verifyOtp(row.reference_no, otp);
    if (!res.ok) {
      if (res.statusCode === "E1850") return bad(reply, 400, "Wrong code. Try again.");
      if (res.statusCode === "E1851" || res.statusCode === "E1855") return bad(reply, 400, "The code expired. Request a new one.");
      return bad(reply, 502, `Verification failed (${res.statusCode}: ${explain(res.statusCode)}).`);
    }
    // Store exactly the subscriberId Applink returns; it may be masked.
    const subscriberId = typeof res.body.subscriberId === "string" && res.body.subscriberId ? res.body.subscriberId : row.address;
    const person = ensurePerson(db, subscriberId, row.name);
    db.run(
      `UPDATE people SET is_member = 1, area_id = COALESCE(?, area_id), subscription_status = ?, subscription_at = ?,
              consent_channel = 'web-otp', consent_text = ?, consent_at = ? WHERE id = ?`,
      row.area_id,
      subscriptionState(res.body.subscriptionStatus) || "REGISTERED",
      nowIso(),
      consentText(),
      nowIso(),
      person.id,
    );
    db.run("UPDATE otp_sessions SET verified_at = ?, subscriber_id = ?, expires_at = ? WHERE token = ?", nowIso(), subscriberId, Date.now() + 30 * 60_000, row.token);
    ctx.bus.publish({ type: "people", id: person.id, summary: "joined via web" });
    return { ok: true, name: person.name, subscription: subscriptionState(res.body.subscriptionStatus) || "REGISTERED" };
  });

  app.post<{ Body: { token?: string; contacts?: { number?: string; name?: string; relation?: string }[] } }>(
    "/api/join/contacts",
    async (req, reply) => {
      const row = db.get<{ subscriber_id: string | null; verified_at: string | null; expires_at: number }>(
        "SELECT subscriber_id, verified_at, expires_at FROM otp_sessions WHERE token = ?",
        String(req.body?.token ?? ""),
      );
      if (!row?.verified_at || !row.subscriber_id || row.expires_at < Date.now()) return bad(reply, 400, "Please verify your number first.");
      const member = ensurePerson(db, row.subscriber_id);
      const results = [];
      for (const c of (req.body?.contacts ?? []).slice(0, 3)) {
        if (!c?.number) continue;
        const r = addContact(ctx, member, c.number, c.name ?? "", c.relation ?? "");
        results.push({ number: c.number, ok: r.ok, reason: r.ok ? undefined : r.reason });
      }
      return { results, contacts: contactsOf(db, member.id).map((c) => ({ name: c.guardian_name, number: maskTel(c.guardian_address), status: c.status })) };
    },
  );
}
