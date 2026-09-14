import type { DecodedField } from "./metar";

export function passengerAirportWeather(decoded?: DecodedField | null, rawMetar?: string | null): string {
  if (!decoded) return "Current conditions unavailable";
  const weather = `${decoded.wx ?? ""} ${rawMetar ?? ""}`.toUpperCase();
  if (/\b(?:TS|TSRA|VCTS)\b|THUNDER/.test(weather)) return "Thunderstorms";
  if (/\b(?:SN|SHSN|BLSN)\b|\bSNOW/.test(weather)) return "Snow";
  if (/\b(?:RA|DZ|SHRA)\b|\bRAIN|DRIZZLE/.test(weather)) return "Rain";
  if (/\bFG\b|\bFOG/.test(weather)) return "Fog";
  if (/\bBR\b|\bMIST/.test(weather)) return "Mist";
  if (/STRONG WIND|GUSTING|\bWINDY\b/i.test(decoded.wind)) return "Windy";
  const sky = `${rawMetar ?? ""} ${decoded.ceiling ?? ""}`.toUpperCase();
  if (/\b(?:OVC|BKN|VV)\d{3}\b|OVERCAST|(?:LOW |VERY LOW )?CEILING (?:AT |AROUND )?\d/.test(sky)) return "Cloudy";
  if (/\bSCT\d{3}\b|SCATTERED CLOUD/.test(sky)) return "Partly cloudy";
  if (/\bFEW\d{3}\b|A FEW CLOUD/.test(sky)) return "Mostly clear";
  if (/\b(?:CLR|SKC|CAVOK|NCD)\b|SKY CLEAR/.test(sky)) return "Clear";
  return "Current conditions available";
}
