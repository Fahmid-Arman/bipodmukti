import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.ts";
import { Db } from "./db.ts";
import { Bus, type Ctx } from "./context.ts";
import { onApplinkCall } from "./applink/client.ts";
import { registerCallbacks } from "./web/callbacks.ts";
import { registerApi } from "./web/api.ts";
import { registerSimulator, simMarkRegistered } from "./sim/network.ts";
import { seedAreas, seedDemo } from "./seed.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Built {
  app: FastifyInstance;
  ctx: Ctx;
}

export async function buildApp(opts: { databasePath?: string; seed?: boolean; logger?: boolean } = {}): Promise<Built> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.logLevel,
      redact: { paths: ["req.headers.authorization", "*.password", "password"], censor: "***" },
    },
    bodyLimit: 64 * 1024,
    trustProxy: true,
  });

  // Applink sends application/json;charset=utf-8. A callback must always get
  // HTTP 200 + S1000, even for an empty or malformed body (a non-2xx makes the
  // platform redeliver), so JSON parsing never throws: bad JSON becomes {} and
  // each route validates its own fields.
  const lenientJson = (_req: unknown, body: string | Buffer, done: (err: Error | null, value?: unknown) => void) => {
    const text = String(body ?? "").trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(null, {});
    }
  };
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, lenientJson);
  app.addContentTypeParser("text/plain", { parseAs: "string" }, lenientJson);

  const db = new Db(opts.databasePath ?? config.databasePath);
  const bus = new Bus();
  const ctx: Ctx = { db, bus, log: app.log };

  seedAreas(db);
  const shouldSeed = opts.seed ?? (process.env.SEED_DEMO === "true" || config.simulator);
  if (shouldSeed) {
    const empty = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM people")!.n === 0;
    if (empty) {
      const members = seedDemo(db);
      if (config.simulator) simMarkRegistered(members);
    }
  }
  if (config.simulator) {
    simMarkRegistered(
      db.all<{ subscriber_id: string }>("SELECT subscriber_id FROM people WHERE subscription_status = 'REGISTERED'").map((r) => r.subscriber_id),
    );
  }

  onApplinkCall((c) => {
    db.run(
      "INSERT INTO api_calls(service, status_code, status_detail, request_id, duration_ms, ok, summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
      c.service,
      c.statusCode,
      c.statusDetail.slice(0, 200),
      c.requestId ?? null,
      c.durationMs,
      c.ok ? 1 : 0,
      c.summary,
    );
    bus.publish({ type: "api", summary: `${c.service} ${c.statusCode}` });
  });

  registerCallbacks(app, ctx);
  registerApi(app, ctx);
  if (config.simulator) registerSimulator(app, ctx);

  await app.register(fastifyStatic, { root: join(root, "public"), extensions: ["html"] });
  app.get("/healthz", async () => ({ ok: true, mode: config.simulator ? "simulator" : "applink" }));

  app.addHook("onClose", async () => db.close());
  return { app, ctx };
}
