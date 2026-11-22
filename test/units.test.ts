import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlainBdTel, maskTel, normaliseTel, telFromTyped } from "../src/applink/address.ts";
import { classify, isRetryable } from "../src/applink/status.ts";
import { parseSms } from "../src/domain/sms.ts";
import { shortcutInputs } from "../src/domain/ussd.ts";
import { clean, screen } from "../src/domain/texts.ts";
import { normaliseDeliveryStatus } from "../src/domain/outbox.ts";
import { subscriptionState } from "../src/applink/client.ts";

test("typed Bangladesh numbers become tel:880 addresses", () => {
  assert.equal(telFromTyped("01912345678"), "tel:8801912345678");
  assert.equal(telFromTyped("+8801412345678"), "tel:8801412345678");
  assert.equal(telFromTyped("880 1912-345678"), "tel:8801912345678");
  assert.equal(telFromTyped("0191234567"), undefined);
  assert.equal(telFromTyped("02912345678"), undefined);
});

test("addresses from Applink are normalised without parsing masked values", () => {
  assert.equal(normaliseTel("tel:+8801959979376"), "tel:8801959979376");
  assert.equal(normaliseTel(" tel:8801959979376 "), "tel:8801959979376");
  assert.equal(normaliseTel("tel:Ab12xYz9"), "tel:Ab12xYz9");
  assert.ok(isPlainBdTel("tel:8801959979376"));
  assert.equal(maskTel("tel:8801959979376"), "01959***376");
});

test("status codes are classified the way the client reacts to them", () => {
  assert.equal(classify("S1000"), "success");
  assert.equal(classify("P1003"), "pending");
  assert.equal(classify("E1313"), "configuration");
  assert.equal(classify("E1343"), "user-state");
  assert.ok(isRetryable("E1318"));
  assert.ok(!isRetryable("E1319"), "daily cap is not retried today");
  assert.ok(!isRetryable("E1312"));
});

test("subscriptionStatus is compared without the trailing dot", () => {
  assert.equal(subscriptionState("UNREGISTERED."), "UNREGISTERED");
  assert.equal(subscriptionState(" registered "), "REGISTERED");
});

test("SMS commands parse with or without the keyword", () => {
  assert.deepEqual(parseSms("BM SAFE"), { kind: "safe", ref: undefined, place: undefined });
  assert.deepEqual(parseSms("bm help rescue at Rajibpur school"), { kind: "help", ref: undefined, need: "rescue", place: "Rajibpur school" });
  assert.deepEqual(parseSms("HELP medical"), { kind: "help", ref: undefined, need: "medical", place: undefined });
  assert.deepEqual(parseSms("BM OK h42"), { kind: "ack", ref: "H42" });
  assert.deepEqual(parseSms("BM SAFE M12"), { kind: "safe", ref: "M12", place: undefined });
  assert.deepEqual(parseSms("BM ADD 01712345678 Karim Uddin"), { kind: "add", number: "01712345678", name: "Karim Uddin" });
  assert.equal(parseSms("STOP").kind, "stop");
  assert.equal(parseSms("bm bipod").kind, "help");
  assert.equal(parseSms("BM").kind, "info");
  assert.equal(parseSms("hello there").kind, "unknown");
});

test("USSD shortcuts feed extra dialled digits as input", () => {
  assert.deepEqual(shortcutInputs("*213*55#", "*213*55#"), []);
  assert.deepEqual(shortcutInputs("*213*55*1#", "*213*55#"), ["1"]);
  assert.deepEqual(shortcutInputs("*213*55*2*1*2#", "*213*55#"), ["2", "1", "2"]);
  assert.deepEqual(shortcutInputs("*999*1#", "*213*55#"), []);
});

test("user text is cleaned before it goes into an SMS or USSD screen", () => {
  assert.equal(clean("  Rajibpur <school>  \n ghat "), "Rajibpur school ghat");
  assert.equal(clean("a".repeat(50), 10).length, 10);
  assert.ok(screen("x".repeat(400)).length <= 160);
  assert.equal(screen("রহিমা Begum"), " Begum");
});

test("delivery statuses accept both spellings", () => {
  assert.equal(normaliseDeliveryStatus("DELIVERED"), "delivered");
  assert.equal(normaliseDeliveryStatus("DELIVRD"), "delivered");
  assert.equal(normaliseDeliveryStatus("UNDELIV"), "failed");
  assert.equal(normaliseDeliveryStatus("ACCEPTED"), "accepted");
});
