import type { FlightStory } from "./types";
import { storyLegDate } from "./flight-story-date.ts";
export function airlineStatusLink(s: FlightStory) {
  const flight = s.iata.replace(/\s/g, "").match(/^([A-Z0-9]{2})(\d+[A-Z]?)$/);
  if (!flight) return null;
  const [, airline, number] = flight;
  const date = flightDepartureDate(s);
  const encode = encodeURIComponent;
  if (airline === "UA") return {url:date ? `https://www.united.com/en/us/flightstatus/details/${encode(number)}/${date}/${encode(s.origin.iata)}/${encode(s.dest.iata)}/UA` : "https://www.united.com/en/us/flightstatus",direct:Boolean(date),date};
  if (airline === "WN") return {url:date ? `https://www.southwest.com/air/flight-status/path?flightNumber=${encode(number)}&departureDate=${date}&searchType=flight` : "https://www.southwest.com/air/flight-status/",direct:Boolean(date),date};
  if (airline === "AA") return {url:"https://www.aa.com/travelInformation/flights/status",direct:false,date};
  return null;
}

export function flightDepartureDate(s: FlightStory) {
  return storyLegDate(s, s.origin.tz || "UTC");
}
