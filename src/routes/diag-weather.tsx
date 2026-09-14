import { createFileRoute } from "@tanstack/react-router";
import { getFlightStory } from "@/lib/story";
import { routeWeatherEvents } from "@/lib/weather-events";
import { rideOutlook } from "@/lib/traveler";

export const Route = createFileRoute("/diag-weather")({
  loader: async () => {
    const story = await getFlightStory({ data: { q: "AA3197", fresh: true } });
    const ahead = story.route.samples.filter((sample) => sample.frac >= story.route.progress);
    const events = routeWeatherEvents(ahead);
    return {
      fetchedAt: story.fetchedAt,
      progress: story.route.progress,
      current: ahead[0] && { frac: ahead[0].frac, etaMin: ahead[0].etaMin, chop: ahead[0].chop, cloud: ahead[0].cloud, convective: ahead[0].convective },
      overview: rideOutlook(story),
      events: events.map((event) => ({
        key: event.key,
        affectedSamples: story.route.samples
          .filter((sample) => event.ranges.some((range) => sample.frac >= range.from && sample.frac <= range.to))
          .map((sample) => ({ frac: sample.frac, etaMin: sample.etaMin, lat: sample.lat, lon: sample.lon, chop: sample.chop, cloud: sample.cloud, convective: sample.convective })),
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
