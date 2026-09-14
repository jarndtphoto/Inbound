import type { RouteSample } from "./types";

export type PassengerWeatherCopy = {
  headline: string;
  body: string | null;
  mapLabel: string;
};

export function passengerWeatherCopy(
  sample: RouteSample,
  nearArrival: boolean,
  destination: string,
  eventKey?: string,
): PassengerWeatherCopy {
  const place = nearArrival && destination ? ` near ${destination}` : "";
  const turbulence = eventKey?.startsWith("turbulence:") || sample.chop !== "smooth";

  if (turbulence) {
    const severity = eventKey?.split(":")[1] || sample.chop;
    const headline = severity === "severe"
      ? nearArrival ? `Quite bumpy air possible${place}` : "Quite bumpy stretch ahead"
      : severity === "moderate"
        ? nearArrival ? `Bumpy air possible${place}` : "Bumpy stretch ahead"
        : nearArrival ? `A few light bumps possible${place}` : "Possible light bumps";
    const mapCondition = severity === "severe"
      ? "Quite bumpy air"
      : severity === "moderate" ? "Moderate bumps" : "Light bumps";
    return {
      headline,
      body: sample.convective
        ? "The flight may route around the roughest weather."
        : sample.cloud ? "Clouds may also limit the view outside." : null,
      mapLabel: `${mapCondition}${place}`,
    };
  }

  if (sample.convective) return {
    headline: nearArrival ? `Storms near ${destination}` : "Thunderstorms near the route",
    body: "The flight may route around the roughest weather.",
    mapLabel: `Thunderstorms${place}`,
  };

  if (sample.cloud) return {
    headline: nearArrival ? `Cloudy stretch near ${destination}` : "Cloudy stretch",
    body: "Clouds may limit the view outside for this part of the flight.",
    mapLabel: `Low clouds${place}`,
  };

  return { headline: "Weather along the route", body: null, mapLabel: "Route weather" };
}
