import { config, describeConfig } from "./config.ts";
import { buildApp } from "./app.ts";
import { startScheduler } from "./scheduler.ts";

const { app, ctx } = await buildApp();
const stop = startScheduler(ctx);

app.log.info(describeConfig(), "BipodMukti starting");
await app.listen({ port: config.port, host: config.host });

const shutdown = async () => {
  stop();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
