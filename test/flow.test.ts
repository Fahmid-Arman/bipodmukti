/**
 * End-to-end flows over real HTTP, using the built-in simulated Applink
 * network: USSD -> help request -> failed delivery -> next contact ->
 * acknowledgement by SMS; duplicate callbacks; roll call with a missed reply;
 * web sign-up with OTP; opt-out.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

const port = await freePort();
process.env.PORT = String(port);
process.env.SIMULATOR_ENABLED = "true";
process.env.ACK_TIMEOUT_SECONDS = "2";
process.env.SCHEDULER_TICK_SECONDS = "1";
process.env.LOG_LEVEL = "silent";

const { buildApp } = await import("../src/app.ts");
const { startScheduler } = await import("../src/scheduler.ts");

const base = `http://127.0.0.1:${port}`;
let close: () => Promise<void>;

before(async () => {
  const { app, ctx } = await buildApp({ databasePath: ":memory:", seed: true, logger: false });
  const stop = startScheduler(ctx);
  await app.listen({ port, host: "127.0.0.1" });
  close = async () => {
    stop();
    await app.close();
  };
});

after(async () => close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json() as Promise<any>;
}
async function get(path: string) {
  return (await fetch(base + path)).json() as Promise<any>;
}

const RAHIMA = encodeURIComponent("tel:8801900000001");
const KARIM = encodeURIComponent("tel:8801900000002");
const RINA = encodeURIComponent("tel:8801400000003");

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error("timed out waiting");
}

test("USSD help request escalates past a switched-off phone and is acknowledged by SMS", async () => {
  await post(`/sim/phones/${KARIM}/power`, { online: false });
  await post(`/sim/phones/${RAHIMA}/ussd`, { dial: true, text: "*213*55*2#" }); // shortcut: straight to HELP
  await waitFor(async () => (await get(`/sim/phones/${RAHIMA}`)).ussd?.screen?.startsWith("What help"));
  await post(`/sim/phones/${RAHIMA}/ussd`, { text: "1" });
  await waitFor(async () => (await get(`/sim/phones/${RAHIMA}`)).ussd?.screen?.startsWith("Where are you"));
  await post(`/sim/phones/${RAHIMA}/ussd`, { text: "2" });
  const done = await waitFor(async () => {
    const p = await get(`/sim/phones/${RAHIMA}`);
    return p.ussd && !p.ussd.open ? p.ussd.screen : undefined;
  });
  assert.match(done, /Help request H\d+ sent/);
  const ref = /H\d+/.exec(done)![0];

  // Karim's phone is off: the delivery report fails and Rina is alerted without waiting.
  const rinaAlert = await waitFor(async () => (await get(`/sim/phones/${RINA}`)).sms.find((m: any) => m.text.includes(`ALERT ${ref}`)));
  assert.ok(rinaAlert);

  await post(`/sim/phones/${RINA}/sms`, { text: `BIPOD OK ${ref}` });
  const inc = await waitFor(async () => (await get("/api/console/incidents")).find((i: any) => i.ref === ref && i.status === "acknowledged"));
  assert.equal(inc.acknowledgedBy.name, "Rina");
  assert.ok(inc.events.some((e: any) => e.type === "delivery_failed"));
  const told = await waitFor(async () => (await get(`/sim/phones/${RAHIMA}`)).sms.find((m: any) => m.text.includes("Rina got your message")));
  assert.ok(told);
  await post(`/sim/phones/${KARIM}/power`, { online: true });
});

test("a replayed MO callback is processed once", async () => {
  const payload = { version: "1.0", applicationId: "APP_SIMULATOR", sourceAddress: "tel:8801900000017", message: "BIPOD HELP food near bazar", requestId: "dup-1", encoding: "0" };
  const a = await post("/api/applink/sms/receive", payload);
  const b = await post("/api/applink/sms/receive", payload);
  assert.deepEqual(a, { statusCode: "S1000", statusDetail: "Success" });
  assert.deepEqual(b, { statusCode: "S1000", statusDetail: "Success" });
  await sleep(500);
  const list = (await get("/api/console/incidents")).filter((i: any) => i.member?.name === "Shahid Mia" && i.kind === "help");
  assert.equal(list.length, 1);
});

test("callbacks answer 200 S1000 even for bad bodies and other apps", async () => {
  for (const body of ["{not json", "", JSON.stringify({ applicationId: "APP_OTHER", sourceAddress: "tel:8801900000001", message: "BIPOD SAFE", requestId: "x1" })]) {
    const res = await fetch(`${base}/api/applink/sms/receive`, { method: "POST", headers: { "Content-Type": "application/json;charset=utf-8" }, body });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).statusCode, "S1000");
  }
});

test("roll call: a missed reply becomes a 'missing' alert that family can close", async () => {
  const rc = await post("/api/console/rollcalls", { areaId: "gabura", title: "Cyclone signal 7", minutes: 1 });
  assert.equal(rc.total, 2);
  await post(`/sim/phones/${encodeURIComponent("tel:8801900000021")}/sms`, { text: "BIPOD SAFE" });
  await waitFor(async () => (await get("/api/console/rollcalls")).find((r: any) => r.id === rc.id && r.safe === 1));
  await post(`/api/console/rollcalls/${rc.id}/close`, {});
  const missing = await waitFor(async () => (await get("/api/console/incidents")).find((i: any) => i.kind === "missing" && i.member?.name === "Harun"));
  const wife = encodeURIComponent("tel:8801900000024");
  await waitFor(async () => (await get(`/sim/phones/${wife}`)).sms.find((m: any) => m.text.includes(missing.ref)));
  await post(`/sim/phones/${wife}/sms`, { text: `BIPOD SAFE ${missing.ref}` });
  const closed = await waitFor(async () => (await get("/api/console/rollcalls")).find((r: any) => r.id === rc.id && r.confirmed_safe === 1));
  assert.equal(closed.no_response, 0);
});

test("web sign-up with OTP verifies the number and adds family contacts", async () => {
  const start = await post("/api/join/start", { name: "Test Member", number: "01911111111", areaId: "tahirpur" });
  assert.ok(start.token);
  const phone = await waitFor(async () => (await get(`/sim/phones/${encodeURIComponent("tel:8801911111111")}`)).sms.find((m: any) => /code is \d{6}/.test(m.text)));
  const otp = /\d{6}/.exec(phone.text)![0];
  const wrong = await post("/api/join/verify", { token: start.token, otp: "000000" });
  assert.match(wrong.error, /Wrong code/);
  const ok = await post("/api/join/verify", { token: start.token, otp });
  assert.equal(ok.subscription, "REGISTERED");
  const c = await post("/api/join/contacts", { token: start.token, contacts: [{ number: "01911111112", name: "Son" }, { number: "123", name: "bad" }] });
  assert.equal(c.results[0].ok, true);
  assert.equal(c.results[1].ok, false);
});

test("BIPOD STOP opts out and stops alerts", async () => {
  const addr = encodeURIComponent("tel:8801900000031");
  await post(`/sim/phones/${addr}/sms`, { text: "BIPOD STOP" });
  await waitFor(async () => (await get("/api/console/people")).every((p: any) => p.name !== "Momena"));
  const msgs = (await get(`/sim/phones/${addr}`)).sms;
  await waitFor(async () => (await get(`/sim/phones/${addr}`)).sms.find((m: any) => m.text.includes("unsubscribed")));
  assert.ok(msgs);
});
