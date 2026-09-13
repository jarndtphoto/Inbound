import type { FlightStory } from "./types";
export function airlineStatusLink(s: FlightStory) {
  const flight = s.iata.replace(/\s/g, "").match(/^([A-Z0-9]{2})(\d+[A-Z]?)$/);
  if (!flight) return null;
  const [, airline, number] = flight;
  const stamp = s.times.origPushUnix ?? s.times.pushUnix ?? s.times.origTakeoffUnix ?? s.times.takeoffUnix;
  let date: string | null = null;
  if (stamp != null && Number.isFinite(stamp) && s.origin.tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {timeZone:s.origin.tz,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(stamp * 1000));
      const part = (type: string) => parts.find(p=>p.type===type)?.value;
      date = part("year")+"-"+part("month")+"-"+part("day");
    } catch {}
  }
  const encode = encodeURIComponent;
  if (airline === "UA") return {url:date ? `https://www.united.com/en/us/flightstatus/details/${encode(number)}/${date}/${encode(s.origin.iata)}/${encode(s.dest.iata)}/UA` : "https://www.united.com/en/us/flightstatus",direct:Boolean(date),date};
  if (airline === "WN") return {url:date ? `https://www.southwest.com/air/flight-status/path?flightNumber=${encode(number)}&departureDate=${date}&searchType=flight` : "https://www.southwest.com/air/flight-status/",direct:Boolean(date),date};
  if (airline === "AA") return {url:"https://www.aa.com/travelInformation/flights/status",direct:false,date};
  return null;
}
