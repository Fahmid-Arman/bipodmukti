/**
 * Applink status codes, grouped by how BipodMukti reacts to them.
 *
 * Applink answers HTTP 200 for failures too, so every decision is made from
 * `statusCode`, never from the HTTP status.
 */

export type StatusClass =
  | "success"
  | "pending"
  | "configuration" // portal or credentials problem: the integration is down
  | "client" // our payload or the user's input is wrong
  | "user-state" // this subscriber cannot be served right now
  | "transient" // retry with backoff
  | "unknown";

const CLASSES: Record<string, StatusClass> = {
  S1000: "success",
  P1003: "pending",

  E1301: "configuration",
  E1303: "configuration",
  E1309: "configuration",
  E1311: "configuration",
  E1313: "configuration",
  E1315: "configuration",
  E1328: "configuration",
  E1331: "configuration",

  E1308: "client",
  E1312: "client",
  E1325: "client",
  E1334: "client",
  E1335: "client",
  E1337: "client",
  E1850: "client",
  E1851: "client",
  E1855: "client",
  E1856: "client",

  E1317: "user-state",
  E1326: "user-state",
  E1342: "user-state",
  E1343: "user-state",

  E1318: "transient",
  E1319: "transient",
  E1341: "transient",
  E1601: "transient",
  E1602: "transient",
  E1603: "transient",
};

export function classify(statusCode: string | undefined): StatusClass {
  if (!statusCode) return "unknown";
  return CLASSES[statusCode.trim().toUpperCase()] ?? "unknown";
}

/** Retry only transient failures. E1319 (daily cap) will not clear today, so it is not retried. */
export function isRetryable(statusCode: string | undefined): boolean {
  if (!statusCode) return false;
  return classify(statusCode) === "transient" && statusCode !== "E1319";
}

/** Short, human explanation for the coordinator console and logs. */
export function explain(statusCode: string | undefined): string {
  switch (statusCode) {
    case "S1000":
      return "Success";
    case "E1303":
      return "Server IP is not in the app's allowed host addresses";
    case "E1309":
      return "This API is not provisioned for the app";
    case "E1313":
      return "Wrong applicationId/password, or the app is not active";
    case "E1317":
      return "Number is invalid or not allowed";
    case "E1318":
      return "Per-second limit reached";
    case "E1319":
      return "Daily limit reached";
    case "E1325":
      return "Address must look like tel:8801XXXXXXXXX";
    case "E1331":
      return "Sender alias is not provisioned";
    case "E1334":
      return "Message too long";
    case "E1342":
      return "Number is blacklisted for this app";
    case "E1343":
      return "Number is not whitelisted (Limited Production)";
    case "E1850":
      return "Wrong OTP";
    case "E1851":
      return "OTP expired";
    case "E1855":
      return "Unknown OTP reference";
    default: {
      const cls = classify(statusCode);
      return cls === "unknown" ? `Unrecognised status ${statusCode ?? "(none)"}` : `${cls} error`;
    }
  }
}
