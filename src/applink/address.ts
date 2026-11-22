/**
 * Subscriber addressing. Every Applink address is `tel:`-prefixed with no
 * spaces. With number masking the value after `tel:` is opaque, so we never
 * parse a value that came from Applink; we only normalise numbers that a
 * person typed in.
 */

export type Tel = `tel:${string}`;

/** Bangladesh mobile number typed by a person: 01XXXXXXXXX, 8801XXXXXXXXX, +8801XXXXXXXXX. */
const BD_MOBILE = /^(?:\+?88)?(01[3-9]\d{8})$/;

/**
 * Turn a typed phone number into `tel:8801XXXXXXXXX`.
 * Returns undefined when the input is not a Bangladesh mobile number.
 */
export function telFromTyped(input: string): Tel | undefined {
  const digits = input.replace(/[\s\-()]/g, "");
  const m = BD_MOBILE.exec(digits);
  if (!m) return undefined;
  return `tel:88${m[1]}`;
}

/**
 * Normalise an address received from Applink or typed in, without parsing
 * masked values: `tel:+8801...` becomes `tel:8801...`, anything else that
 * already has `tel:` is kept as is.
 */
export function normaliseTel(address: string): Tel {
  const trimmed = address.trim().replace(/\s+/g, "");
  if (trimmed.toLowerCase().startsWith("tel:")) {
    const rest = trimmed.slice(4);
    if (/^\+880\d{10}$/.test(rest)) return `tel:${rest.slice(1)}`;
    return `tel:${rest}`;
  }
  const typed = telFromTyped(trimmed);
  if (typed) return typed;
  return `tel:${trimmed}`;
}

/** Is this a plain (unmasked) Bangladesh mobile address? */
export function isPlainBdTel(address: string): boolean {
  return /^tel:8801[3-9]\d{8}$/.test(address);
}

/** Banglalink prefixes are 019 and 014. */
export function isBanglalink(address: string): boolean {
  return /^tel:880(19|14)\d{8}$/.test(address);
}

/** For logs and the console: tel:8801712345678 -> 01712***678. Masked values are shortened. */
export function maskTel(address: string | undefined | null): string {
  if (!address) return "-";
  if (isPlainBdTel(address)) {
    const local = `0${address.slice(7)}`; // 01XXXXXXXXX
    return `${local.slice(0, 5)}***${local.slice(-3)}`;
  }
  const v = address.replace(/^tel:/, "");
  return v.length > 6 ? `${v.slice(0, 3)}…${v.slice(-3)}` : "***";
}

/** For SMS text shown to family: tel:8801712345678 -> 01712345678. Masked values stay hidden. */
export function displayNumber(address: string): string {
  if (isPlainBdTel(address)) return `0${address.slice(7)}`;
  return "(hidden number)";
}
