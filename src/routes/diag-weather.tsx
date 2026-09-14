import { createFileRoute } from "@tanstack/react-router";
import { getFlightStory } from "@/lib/story";
import { routeWeatherEvents, weatherEventMarker } from "@/lib/weather-events";
import { rideOutlook } from "@/lib/traveler";

export const Route = createFileRoute("/diag-weather")({
  loader: async () => {
    const story = await getFlightStory({ data: { q: "AA3197", fresh: true } });
    const events = routeWeatherEvents(story.route.samples, story.route.progress);
    return {
      fetchedAt: story.fetchedAt,
      progress: story.route.progress,
      overview: rideOutlook(story),
      events: events.map((event) => ({
        key: event.key,
        affectedSamples: story.route.samples.filter((sample) =>
          event.ranges.some((range) => sample.frac >= range.from && sample.frac <= range.to))
          .map((sample) => ({ frac: sample.frac, etaMin: sample.etaMin, lat: sample.lat, lon: sample.lon, chop: sample.chop, cloud: sample.cloud, convective: sample.convective })),
        startFrac: event.startFrac, endFrac: event.endFrac,
        startEtaMin: event.startEtaMin, endEtaMin: event.endEtaMin,
        start: { lat: event.start.lat, lon: event.start.lon },
        end: { lat: event.end.lat, lon: event.end.lon },
        marker: weatherEventMarker(event)
      }))
    };
  },
  component: DiagnosticWeather
});
function DiagnosticWeather() { return <pre>{JSON.stringify(Route.useLoaderData(), null, 2)}</pre>; }
