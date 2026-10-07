const BASE9 = "123456789";
const BASE10 = "0123456789";
const BASE34 = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
const ICAO_OFFSET = 0xA00001;
const B1 = 101711;
const B2 = 10111;

function encodeSuffix(suffix: string) {
  if (!suffix) return 0;
  const first = BASE34.indexOf(suffix[0]!);
  if (first < 0) return null;
  const second = suffix.length === 1 ? 0 : BASE34.indexOf(suffix[1]!) + 1;
  if (second < 0) return null;
  return first < 24
    ? first * 25 + second + 1
    : first * 35 + second - 239;
}

/** FAA U.S. civil N-numbers map deterministically to the U.S. ICAO block. */
export function usRegistrationHex(registration: string | null | undefined): string | null {
  const tail = String(registration ?? "").replace(/[-\s]/g, "").toUpperCase();
  if (!/^N[1-9](?:\d{0,4}|\d{0,3}[A-HJ-NP-Z]|\d{0,2}[A-HJ-NP-Z]{2})$/.test(tail)) return null;

  let value = ICAO_OFFSET + BASE9.indexOf(tail[1]!) * B1;
  const rest = tail.slice(2);
  if (!rest) return value.toString(16).padStart(6, "0");

  const secondDigit = BASE10.indexOf(rest[0]!);
  if (secondDigit < 0) {
    const suffix = encodeSuffix(rest);
    if (suffix == null) return null;
    value += suffix;
    return value.toString(16).padStart(6, "0");
  }

  value += secondDigit * B2 + 601;
  if (rest.length === 1) return value.toString(16).padStart(6, "0");

  const thirdDigit = BASE10.indexOf(rest[1]!);
  if (thirdDigit >= 0) {
    value += thirdDigit * 951 + 601;
    const suffix = encodeSuffix(rest.slice(2));
    if (suffix == null) return null;
    value += suffix;
  } else {
    const suffix = encodeSuffix(rest.slice(1));
    if (suffix == null) return null;
    value += suffix;
  }

  return value.toString(16).padStart(6, "0");
}
