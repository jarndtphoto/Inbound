import { createFileRoute } from "@tanstack/react-router";
import { loadFlightStory } from "@/lib/story.server";
import { routeWeatherEvents } from "@/lib/weather-events";
import { rideOutlook } from "@/lib/traveler";

export const Route = createFileRoute("/diag-weather")({
  loader: async () => {
    const story = await loadFlightStory("AA3197", { fresh: true });
    const ahead = story.route.samples.filter((sample) => sample.frac >= story.route.progress);
    const events = routeWeatherEvents(ahead);
    return {
      fetchedAt: story.fetchedAt,
      progress: story.route.progress,
      overview: rideOutlook(story),
      events: events.map((event) => ({
        affectedSamples: story.route.samples
          .filter((sample) => event.ranges.some((range) => sample.frac >= range.from && sample.frac <= range.to))
          .map((sample) => ({ frac: sample.frac, etaMin: sample.etaMin, lat: sample.lat, lon: sample.lon })),
        startFrac: event.startFrac,
        endFrac: event.endFrac,
        startEtaMin: event.startEtaMin,
        endEtaMin: event.endEtaMin,
        start: { lat: event.start.lat, lon: event.start.lon },
        end: { lat: event.end.lat, lon: event.end.lon },
        marker: { lat: event.start.lat, lon: event.start.lon }
      }))
    };
  },
  component: DiagnosticWeather
});

function DiagnosticWeather() {
  return <pre>{JSON.stringify(Route.useLoaderData(), null, 2)}</pre>;
}
