/**
 * Conformance check against hSenid's official Applink mock server.
 *
 * 1. Clone https://github.com/hSenidMobileCPaaS/Applink-as-a-skill somewhere.
 * 2. In that folder:  node scripts/mock-applink.mjs --port 8089
 * 3. Here:            npm run conformance
 *
 * Every BipodMukti wrapper is called against the mock's normal, /variant/ and
 * /fail/ routes. The mock validates each body against the Applink contract;
 * the bar is zero BAD requests in its /__report, and our client must read
 * every response (including failure and minimal "variant" bodies) correctly.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MOCK = process.env.APPLINK_MOCK_URL ?? "http://127.0.0.1:8089";

const SERVICES: Record<string, string> = {
  APPLINK_SMS_SEND_URL: "/sms/send",
  APPLINK_USSD_SEND_URL: "/ussd/send",
  APPLINK_SUBSCRIPTION_SEND_URL: "/subscription/send",
  APPLINK_SUBSCRIPTION_QUERY_BASE_URL: "/subscription/query-base",
  APPLINK_SUBSCRIPTION_CHARGING_INFO_URL: "/subscription/getSubscriberChargingInfo",
  APPLINK_OTP_REQUEST_URL: "/otp/request",
  APPLINK_OTP_VERIFY_URL: "/otp/verify",
};

interface Row {
  scenario: string;
  service: string;
  ok: boolean;
  statusCode: string;
  cls: string;
}

/** Child mode: call every wrapper once with the URLs from the environment. */
async function child(): Promise<void> {
  const c = await import("../src/applink/client.ts");
  const sub = "tel:8801912345678";
  const results = [
    await c.sendSms([sub], "BipodMukti conformance test"),
    await c.sendUssd("1330929317043", sub, "1 SAFE\n2 HELP", "mt-cont"),
    await c.subscribe(sub),
    await c.unsubscribe(sub),
    await c.queryBaseSize(),
    await c.getChargingInfo([sub]),
    await c.requestOtp(sub, { client: "WEBAPP", device: "Browser", os: "test", appCode: "https://example.org/join" }),
    await c.verifyOtp("213561321321613", "123564"),
  ];
  const rows: Row[] = results.map((r) => ({ scenario: process.env.SCENARIO || "/", service: r.service, ok: r.ok, statusCode: r.statusCode, cls: r.cls }));
  process.stdout.write(JSON.stringify(rows));
}

async function main(): Promise<void> {
  try {
    await fetch(`${MOCK}/__report`);
  } catch {
    console.error(`No Applink mock at ${MOCK}. Start it first: node scripts/mock-applink.mjs --port 8089 (in the Applink-as-a-skill repo).`);
    process.exit(2);
  }
  const rows: Row[] = [];
  for (const scenario of ["", "/variant", "/fail"]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CONFORMANCE_CHILD: "1",
      SCENARIO: scenario || "/",
      SIMULATOR_ENABLED: "false",
      APPLINK_APP_ID: process.env.APPLINK_APP_ID ?? "APP_000375",
      APPLINK_PASSWORD: process.env.APPLINK_PASSWORD ?? "mock-password",
    };
    for (const [k, path] of Object.entries(SERVICES)) env[k] = `${MOCK}${scenario}${path}`;
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: "utf8" });
    rows.push(...(JSON.parse(out) as Row[]));
  }
  console.table(rows);

  const report = (await (await fetch(`${MOCK}/__report`)).json()) as { verdict: string; service: string; problems: string[] }[];
  const bad = report.filter((r) => r.verdict === "BAD");
  const sampleOk = rows.filter((r) => r.scenario === "/").every((r) => r.ok);
  const variantOk = rows.filter((r) => r.scenario === "/variant").every((r) => r.ok);
  const failuresSeen = rows.filter((r) => r.scenario === "/fail").every((r) => !r.ok && r.statusCode.startsWith("E"));
  console.log(`\nMock saw ${report.length} request(s), ${bad.length} BAD.`);
  for (const b of bad) console.log(`  BAD ${b.service}: ${b.problems.join("; ")}`);
  console.log(`Sample responses read as success: ${sampleOk}. Minimal/variant responses read as success: ${variantOk}. Failure bodies detected: ${failuresSeen}.`);
  process.exit(bad.length === 0 && sampleOk && variantOk && failuresSeen ? 0 : 1);
}

if (process.env.CONFORMANCE_CHILD) await child();
else await main();
