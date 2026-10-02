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
    const mixed = severity.includes("-");
    const [low, high] = mixed ? severity.split("-") : [severity, severity];
    const headline = severity === "light-moderate"
      ? nearArrival ? `Light to moderate bumps possible${place}` : "Light to moderate bumps ahead"
      : severity === "moderate-severe"
        ? nearArrival ? `Moderate to severe bumps possible${place}` : "Moderate to severe bumps ahead"
        : severity === "light-severe"
          ? nearArrival ? `Light to severe bumps possible${place}` : "Light to severe bumps ahead"
          : high === "severe"
            ? nearArrival ? `Quite bumpy air possible${place}` : "Quite bumpy stretch ahead"
            : high === "moderate"
              ? nearArrival ? `Bumpy air possible${place}` : "Bumpy stretch ahead"
              : nearArrival ? `A few light bumps possible${place}` : "Possible light bumps";
    const mapCondition = severity === "light-moderate"
      ? "Light to moderate bumps"
      : severity === "moderate-severe"
        ? "Moderate to severe bumps"
        : severity === "light-severe"
          ? "Light to severe bumps"
          : high === "severe"
            ? "Quite bumpy air"
            : high === "moderate" ? "Moderate bumps" : "Light bumps";
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
