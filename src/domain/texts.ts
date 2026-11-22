/**
 * Every SMS and USSD text in one place.
 *
 * SMS: plain GSM text, aimed at one 160-character part. USSD: plain ASCII
 * (encoding 440), one screen kept under 160 characters.
 * Anything a person typed is cleaned before it goes into an outbound message.
 */

import { config } from "../config.ts";

const { keyword: KW, shortcode: SC, ussdCode: USSD } = config.applink;

/** Keep letters, digits and basic punctuation only; collapse spaces; cap length. */
export function clean(input: string | undefined | null, max = 40): string {
  if (!input) return "";
  const ascii = input
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[<>{}\[\]\\^`|~"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return ascii.length > max ? `${ascii.slice(0, max - 1).trimEnd()}.` : ascii;
}

/** First name, or a fallback, for short messages. */
export function shortName(name: string | undefined | null, fallback = "Your family member"): string {
  const n = clean(name, 24);
  return n || fallback;
}

export function hhmm(iso: string = new Date().toISOString()): string {
  // Bangladesh time (UTC+6), 24h.
  const d = new Date(new Date(iso).getTime() + 6 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export const NEED_LABEL: Record<string, string> = {
  rescue: "RESCUE",
  medical: "MEDICAL help",
  food: "FOOD/WATER",
  other: "HELP",
};

/** "3 min", or "45 sec" for short demo timers. */
export function waitLabel(seconds: number): string {
  return seconds < 60 ? `${seconds} sec` : `${Math.round(seconds / 60)} min`;
}

export const sms = {
  helpAlert(p: { ref: string; name: string; number: string; need: string; place: string; at: string }): string {
    return `BipodMukti ALERT ${p.ref}: ${p.name} (${p.number}) needs ${NEED_LABEL[p.need] ?? "HELP"} at ${p.place}, ${hhmm(p.at)}. Reply ${KW} OK ${p.ref} if you can help. Emergency 999`;
  },

  volunteerAlert(p: { ref: string; name: string; area: string; need: string; place: string }): string {
    return `BipodMukti URGENT ${p.ref}: ${p.name} in ${p.area} needs ${NEED_LABEL[p.need] ?? "HELP"} at ${p.place}. Family not reached. Reply ${KW} OK ${p.ref} if you can go.`;
  },

  volunteerMissing(p: { ref: string; name: string; area: string }): string {
    return `BipodMukti URGENT ${p.ref}: No news from ${p.name} in ${p.area} after the safety check, and family has not confirmed. Reply ${KW} OK ${p.ref} if you can check on them.`;
  },

  missingAlert(p: { ref: string; name: string; area: string; title: string }): string {
    return `BipodMukti ${p.ref}: No reply from ${p.name} (${p.area}) to the "${p.title}" check. If you know they are safe reply ${KW} SAFE ${p.ref}. If not, reply ${KW} HELP ${p.ref}`;
  },

  safeInfo(p: { name: string; place: string; at: string }): string {
    return `BipodMukti: ${p.name} checked in SAFE at ${p.place}, ${hhmm(p.at)}. No action needed.`;
  },

  movingInfo(p: { name: string; place: string; at: string }): string {
    return `BipodMukti: ${p.name} is moving to ${p.place}, ${hhmm(p.at)}. We will tell you when they check in again.`;
  },

  ackToMember(p: { ref: string; by: string }): string {
    return `BipodMukti ${p.ref}: ${p.by} got your message and is responding. Stay where it is safe. Emergency 999`;
  },

  ackToOthers(p: { ref: string; by: string; name: string }): string {
    return `BipodMukti ${p.ref}: ${p.by} is now handling ${p.name}'s request. We will update you.`;
  },

  ackConfirm(p: { ref: string; name: string }): string {
    return `BipodMukti ${p.ref}: Thank you. You are now handling ${p.name}'s request. Send ${KW} DONE ${p.ref} when ${p.name} is safe.`;
  },

  alreadyHandled(p: { ref: string; by: string }): string {
    return `BipodMukti ${p.ref}: Already being handled by ${p.by}. Thank you.`;
  },

  resolvedToContacts(p: { ref: string; name: string; how: string }): string {
    return `BipodMukti ${p.ref}: Closed. ${p.name} ${p.how}.`;
  },

  rollCall(p: { code: string; title: string; minutes: number }): string {
    return `BipodMukti CHECK ${p.code}: ${p.title}. Reply ${KW} SAFE or ${KW} HELP to ${SC}, or dial ${USSD}. Please reply within ${p.minutes} min.`;
  },

  invite(p: { member: string; number: string }): string {
    return `BipodMukti: ${p.member} (${p.number}) added you as a family contact. You get an SMS if they need help in a flood or cyclone. Reply ${KW} YES to accept, ${KW} NO to decline.`;
  },

  inviteAccepted(p: { guardian: string }): string {
    return `BipodMukti: ${p.guardian} accepted. They will get your check-ins and help requests.`;
  },

  welcome(): string {
    return `Welcome to BipodMukti. Check in: send ${KW} SAFE or ${KW} HELP to ${SC}, or dial ${USSD}. Add family: ${KW} ADD 01XXXXXXXXX Name. Stop: ${KW} STOP`;
  },

  checkInReceipt(p: { ref: string; kind: string; told: number }): string {
    if (p.kind === "help") {
      return p.told > 0
        ? `BipodMukti ${p.ref}: Help request sent to your family. If they do not reply we alert the next contact, then local volunteers. Emergency 999`
        : `BipodMukti ${p.ref}: Help request received. Local volunteers are alerted. Add family: ${KW} ADD 01XXXXXXXXX Name. Emergency 999`;
    }
    if (p.kind === "moving") return `BipodMukti ${p.ref}: Noted. We told ${p.told} family contact(s) you are moving.`;
    return `BipodMukti ${p.ref}: Marked SAFE. We told ${p.told} family contact(s).`;
  },

  guardianConfirmedSafe(p: { ref: string; name: string; by: string }): string {
    return `BipodMukti ${p.ref}: ${p.by} confirmed ${p.name} is safe. Thank you.`;
  },

  contactAdded(p: { name: string }): string {
    return `BipodMukti: We asked ${p.name} to accept being your family contact. They get your alerts from now on.`;
  },

  stopped(): string {
    return `BipodMukti: You are unsubscribed and will get no more messages. To join again send ${KW} JOIN to ${SC}.`;
  },

  status(p: { name: string; contacts: number; open?: string }): string {
    return `BipodMukti: ${p.name}, you have ${p.contacts} family contact(s).${p.open ? ` Open request: ${p.open}.` : ""} Dial ${USSD} to check in.`;
  },

  help(): string {
    return `BipodMukti: ${KW} SAFE, ${KW} HELP rescue|medical|food <place>, ${KW} ADD <number> <name>, ${KW} OK <ref>, ${KW} STOP. Or dial ${USSD}`;
  },

  notFound(p: { ref: string }): string {
    return `BipodMukti: We could not find request ${p.ref}, or you are not a contact for it.`;
  },

  badNumber(): string {
    return `BipodMukti: That number does not look right. Send ${KW} ADD 01XXXXXXXXX Name`;
  },

  tooManyContacts(): string {
    return `BipodMukti: You already have 3 family contacts. Dial ${USSD} to manage them.`;
  },
};

/** USSD screens: ASCII only, one screen. */
export function screen(text: string): string {
  const ascii = text.replace(/[^\x0A\x20-\x7E]/g, "");
  return ascii.length > 160 ? `${ascii.slice(0, 157)}...` : ascii;
}
