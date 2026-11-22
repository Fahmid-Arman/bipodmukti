import { config } from "./config.ts";
import type { Ctx } from "./context.ts";
import { processDueEscalations } from "./domain/incidents.ts";
import { processRollCallDeadlines } from "./domain/rollcall.ts";
import { flush } from "./domain/outbox.ts";
import { purgeExpiredUssd } from "./domain/ussd.ts";
import { refreshBaseSize } from "./domain/subscriptions.ts";

/**
 * One timer drives everything time-based. All state is in SQLite, so after a
 * restart the next tick picks up exactly where the last one stopped.
 */
export function startScheduler(ctx: Ctx): () => void {
  let running = false;
  let lastBaseSize = 0;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      processRollCallDeadlines(ctx);
      processDueEscalations(ctx);
      await flush(ctx);
      purgeExpiredUssd(ctx);
      ctx.db.run("DELETE FROM otp_sessions WHERE expires_at < ?", Date.now() - 3600_000);
      ctx.db.run("DELETE FROM rate_limits WHERE at < ?", Date.now() - 24 * 3600_000);
      if (Date.now() - lastBaseSize > 10 * 60_000) {
        lastBaseSize = Date.now();
        await refreshBaseSize(ctx);
      }
    } catch (err) {
      ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "scheduler tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.escalation.tickSeconds * 1000);
  setTimeout(() => void tick(), 1500);
  return () => clearInterval(timer);
}
