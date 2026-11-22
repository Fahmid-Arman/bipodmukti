/**
 * BipodMukti's Applink client.
 *
 * One `post()` that injects credentials, enforces a timeout and reads
 * `statusCode`, plus one thin wrapper per Applink service we use:
 * SMS, USSD, Subscription and OTP.
 *
 * Written from the published Applink API contract
 * (https://dev.applink.com.bd/docs). Rules we follow:
 *  - every request value is a JSON string (arrays/objects only where the API says so)
 *  - optional fields are omitted, never sent as null or ""
 *  - HTTP 200 does not mean success; statusCode does
 *  - credentials never appear in logs or in anything sent to a browser
 */

import { config, type ServiceName } from "../config.ts";
import { classify, isRetryable, type StatusClass } from "./status.ts";
import { normaliseTel } from "./address.ts";

type WireValue = string | string[] | Record<string, string>;
type WireBody = Record<string, WireValue>;

export interface ApplinkResult<T = Record<string, unknown>> {
  service: ServiceName;
  /** True when statusCode is the expected outcome for this endpoint. */
  ok: boolean;
  statusCode: string;
  statusDetail: string;
  cls: StatusClass;
  retryable: boolean;
  requestId?: string;
  durationMs: number;
  /** Parsed response body. Read every field with a default. */
  body: Partial<T>;
  /** Set when the call never got an Applink answer (timeout, DNS, refused...). */
  transportError?: string;
}

export interface CallRecord {
  service: ServiceName;
  statusCode: string;
  statusDetail: string;
  requestId?: string;
  durationMs: number;
  ok: boolean;
  /** Safe summary of what was sent, no credentials, no OTPs. */
  summary: string;
}

type Observer = (record: CallRecord) => void;
const observers: Observer[] = [];

/** Subscribe to every Applink call (used for the console's API log and metrics). */
export function onApplinkCall(observer: Observer): void {
  observers.push(observer);
}

/** Missing service URL = API not provisioned for this deployment. */
export class ServiceNotConfiguredError extends Error {
  readonly service: ServiceName;
  constructor(service: ServiceName) {
    super(`Applink ${service} is not configured. Set its APPLINK_*_URL, or enable it on the app.`);
    this.service = service;
  }
}

function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

async function post<T>(
  service: ServiceName,
  fields: WireBody,
  summary: string,
  expected: string = "S1000",
): Promise<ApplinkResult<T>> {
  const endpoint = config.applink.endpoints[service];
  if (!endpoint) throw new ServiceNotConfiguredError(service);

  const body: WireBody = {
    applicationId: config.applink.applicationId,
    password: config.applink.password,
    ...fields,
  };

  const started = Date.now();
  let result: ApplinkResult<T>;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.applink.timeoutMs),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      const json: unknown = JSON.parse(text);
      if (json && typeof json === "object" && !Array.isArray(json)) parsed = json as Record<string, unknown>;
    } catch {
      // Not JSON: treated as an unknown failure below.
    }
    const statusCode = str(parsed.statusCode, res.ok ? "UNKNOWN" : `HTTP${res.status}`);
    const statusDetail = str(parsed.statusDetail, res.ok ? "No statusCode in response" : `HTTP ${res.status}`);
    result = {
      service,
      ok: statusCode === expected,
      statusCode,
      statusDetail,
      cls: classify(statusCode),
      retryable: isRetryable(statusCode) || (!res.ok && res.status >= 500),
      requestId: str(parsed.requestId) || undefined,
      durationMs: Date.now() - started,
      body: parsed as Partial<T>,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      service,
      ok: false,
      statusCode: "TRANSPORT",
      statusDetail: message,
      cls: "transient",
      retryable: true,
      durationMs: Date.now() - started,
      body: {},
      transportError: message,
    };
  }

  const record: CallRecord = {
    service,
    statusCode: result.statusCode,
    statusDetail: result.statusDetail,
    requestId: result.requestId,
    durationMs: result.durationMs,
    ok: result.ok,
    summary,
  };
  for (const observe of observers) {
    try {
      observe(record);
    } catch {
      // An observer must never break a telco call.
    }
  }
  return result;
}

/* ── SMS ──────────────────────────────────────────────────────────────── */

export interface SmsDestinationResponse {
  address?: string;
  messageId?: string;
  statusCode?: string;
  statusDetail?: string;
  timeStamp?: string;
}

export interface SmsSendBody {
  requestId?: string;
  destinationResponses?: SmsDestinationResponse[];
}

/** Send an MT SMS. `destinations` is always sent as an array. */
export function sendSms(
  destinations: string[],
  message: string,
  opts: { deliveryReport?: boolean } = {},
): Promise<ApplinkResult<SmsSendBody>> {
  if (destinations.length === 0) throw new Error("sendSms needs at least one destination");
  const addresses = destinations.map((d) => (d === "tel:all" ? d : normaliseTel(d)));
  if (addresses.includes("tel:all") && !config.applink.allowBroadcast) {
    throw new Error("Broadcast (tel:all) is disabled. Set APPLINK_ALLOW_BROADCAST=true to allow it.");
  }
  const fields: WireBody = {
    version: "1.0",
    message,
    destinationAddresses: addresses,
    encoding: "0",
  };
  if (config.applink.smsSourceAddress) fields.sourceAddress = config.applink.smsSourceAddress;
  const wantReport = opts.deliveryReport ?? config.applink.deliveryReports;
  if (wantReport) fields.deliveryStatusRequest = "1";
  return post<SmsSendBody>("smsSend", fields, `SMS to ${addresses.length} recipient(s), ${message.length} chars`);
}

/* ── USSD ─────────────────────────────────────────────────────────────── */

export type UssdOperation = "mt-cont" | "mt-fin";

/** Send one USSD screen inside a session the platform opened. Echo its sessionId. */
export function sendUssd(
  sessionId: string,
  destination: string,
  message: string,
  operation: UssdOperation,
): Promise<ApplinkResult> {
  return post("ussdSend", {
    version: "1.0",
    message,
    sessionId,
    ussdOperation: operation,
    destinationAddress: normaliseTel(destination),
    encoding: "440",
  }, `USSD ${operation} screen, ${message.length} chars`);
}

/* ── Subscription ────────────────────────────────────────────────────── */

export interface SubscriptionBody {
  subscriptionStatus?: string;
}

/** Opt in (action "1"). Read subscriptionStatus: REGISTERED is the state we want. */
export function subscribe(subscriberId: string): Promise<ApplinkResult<SubscriptionBody>> {
  return post<SubscriptionBody>("subscriptionSend", { subscriberId, action: "1" }, "Subscription register");
}

/** Opt out (action "0"). UNREGISTERED is success even if they were never registered. */
export function unsubscribe(subscriberId: string): Promise<ApplinkResult<SubscriptionBody>> {
  return post<SubscriptionBody>("subscriptionSend", { subscriberId, action: "0" }, "Subscription unregister");
}

export interface BaseSizeBody {
  baseSize?: string | number;
}

/** Cheapest call: no subscriber, no charge. Doubles as a health check. */
export function queryBaseSize(): Promise<ApplinkResult<BaseSizeBody>> {
  return post<BaseSizeBody>("subscriptionQueryBase", {}, "Base size");
}

export interface ChargingInfoEntry {
  subscriberId?: string;
  subscriptionStatus?: string;
  lastChargedDate?: string;
  lastChargedAmount?: string;
  statusCode?: string;
}

/** Reconciliation lookup, at most ten subscribers per call. Never on a request path. */
export function getChargingInfo(
  subscriberIds: string[],
): Promise<ApplinkResult<{ destinationResponses?: ChargingInfoEntry[] }>> {
  if (subscriberIds.length === 0 || subscriberIds.length > 10) {
    throw new Error("getChargingInfo takes 1 to 10 subscriberIds");
  }
  return post("subscriptionChargingInfo", { subscriberIds }, `Charging info for ${subscriberIds.length}`);
}

/** Compare by prefix: published samples carry a trailing dot ("UNREGISTERED."). */
export function subscriptionState(raw: unknown): string {
  return str(raw).trim().toUpperCase().replace(/\.+$/, "");
}

/* ── OTP (subscription activation from the web) ──────────────────────── */

export interface OtpRequestBody {
  referenceNo?: string;
}

export function requestOtp(
  subscriberId: string,
  meta?: { client: string; device: string; os: string; appCode: string },
): Promise<ApplinkResult<OtpRequestBody>> {
  const fields: WireBody = { subscriberId };
  if (meta) fields.applicationMetaData = meta;
  return post<OtpRequestBody>("otpRequest", fields, "OTP request");
}

export interface OtpVerifyBody {
  subscriptionStatus?: string;
  subscriberId?: string;
}

export function verifyOtp(referenceNo: string, otp: string): Promise<ApplinkResult<OtpVerifyBody>> {
  return post<OtpVerifyBody>("otpVerify", { referenceNo, otp }, "OTP verify");
}

/** Read a numeric string field defensively (Applink sends numbers as strings). */
export function intField(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number.parseInt(str(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

export { str as stringField };
