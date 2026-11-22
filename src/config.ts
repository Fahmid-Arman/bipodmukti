/**
 * The only module that reads process.env.
 *
 * Applink credentials and one URL per provisioned Applink service. An unset
 * service URL means that API is not enabled for this deployment, and the client
 * refuses to call it instead of getting E1309 from the platform.
 *
 * Server-side only. Nothing here is ever sent to a browser.
 */

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim();
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(
      `[config] Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`[config] ${name} must be an integer, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function url(name: string): string | undefined {
  const value = env(name);
  return value ? value.replace(/\/+$/, "") : undefined;
}

const port = int("PORT", 3000);
const publicBaseUrl = env("PUBLIC_BASE_URL", `http://127.0.0.1:${port}`)!.replace(/\/+$/, "");
const simulator = bool("SIMULATOR_ENABLED", false);

/**
 * In simulator mode every Applink URL that is not set explicitly points at the
 * built-in simulated network, so the full HTTP path is exercised locally.
 */
function serviceUrl(name: string, simPath: string): string | undefined {
  const explicit = url(name);
  if (explicit) return explicit;
  return simulator ? `http://127.0.0.1:${port}/sim/applink${simPath}` : undefined;
}

export const config = {
  port,
  host: env("HOST", "0.0.0.0")!,
  publicBaseUrl,
  databasePath: env("DATABASE_PATH", "data/bipodmukti.db")!,
  logLevel: env("LOG_LEVEL", "info")!,

  /** Coordinator console password. Unset = open console (local demo only). */
  dashboardPassword: env("DASHBOARD_PASSWORD"),

  simulator,

  applink: {
    /** Never log these. Never send them to a client. */
    applicationId: simulator ? env("APPLINK_APP_ID", "APP_SIMULATOR")! : requireEnv("APPLINK_APP_ID"),
    password: simulator ? env("APPLINK_PASSWORD", "simulator-password")! : requireEnv("APPLINK_PASSWORD"),
    timeoutMs: int("APPLINK_TIMEOUT_MS", 15_000),
    /** SMS keyword that routes MO messages to us, e.g. "BM SAFE". */
    keyword: env("APPLINK_SMS_KEYWORD", "BM")!.toUpperCase(),
    /** Shortcode users send SMS to. Display only; Applink assigns it. */
    shortcode: env("APPLINK_SMS_SHORTCODE", "21213")!,
    /** USSD code users dial. Display only; Applink assigns it. */
    ussdCode: env("APPLINK_USSD_CODE", "*213*55#")!,
    /** Provisioned sender alias. Leave unset to use the platform default. */
    smsSourceAddress: env("APPLINK_SMS_SOURCE_ADDRESS"),
    /** Ask for delivery reports. Only when the report callback URL is registered. */
    deliveryReports: bool("APPLINK_DELIVERY_REPORTS", true),
    /** Allow the tel:all broadcast for whole-base roll calls. */
    allowBroadcast: bool("APPLINK_ALLOW_BROADCAST", false),
    /** Price disclosure shown before any subscription. */
    subscriptionTerms: env("SUBSCRIPTION_TERMS", "Free during the pilot")!,
    endpoints: {
      smsSend: serviceUrl("APPLINK_SMS_SEND_URL", "/sms/send"),
      ussdSend: serviceUrl("APPLINK_USSD_SEND_URL", "/ussd/send"),
      subscriptionSend: serviceUrl("APPLINK_SUBSCRIPTION_SEND_URL", "/subscription/send"),
      subscriptionQueryBase: serviceUrl("APPLINK_SUBSCRIPTION_QUERY_BASE_URL", "/subscription/query-base"),
      subscriptionChargingInfo: serviceUrl(
        "APPLINK_SUBSCRIPTION_CHARGING_INFO_URL",
        "/subscription/getSubscriberChargingInfo",
      ),
      otpRequest: serviceUrl("APPLINK_OTP_REQUEST_URL", "/otp/request"),
      otpVerify: serviceUrl("APPLINK_OTP_VERIFY_URL", "/otp/verify"),
    },
  },

  escalation: {
    /** How long a contact has to acknowledge a help request before we move on. */
    ackTimeoutSeconds: int("ACK_TIMEOUT_SECONDS", 180),
    /** How often the scheduler wakes up. */
    tickSeconds: int("SCHEDULER_TICK_SECONDS", 5),
  },

  rollCall: {
    defaultDeadlineMinutes: int("ROLL_CALL_DEFAULT_MINUTES", 30),
  },
} as const;

export type ServiceName = keyof typeof config.applink.endpoints;

export function enabledServices(): ServiceName[] {
  return (Object.keys(config.applink.endpoints) as ServiceName[]).filter(
    (s) => config.applink.endpoints[s] !== undefined,
  );
}

/** Redacted view, safe to log at startup. */
export function describeConfig(): Record<string, unknown> {
  return {
    mode: config.simulator ? "simulator" : "applink",
    applicationId: config.applink.applicationId,
    password: "***",
    enabledServices: enabledServices(),
    keyword: config.applink.keyword,
    shortcode: config.applink.shortcode,
    ussdCode: config.applink.ussdCode,
    publicBaseUrl: config.publicBaseUrl,
  };
}
