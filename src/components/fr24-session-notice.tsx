import type { FlightStory } from "@/lib/types";

export function Fr24AccessStoppedNotice({ onHome }: { onHome: () => void }) {
  return <section role="alert" className="rounded-md border border-ifr/40 bg-surface px-4 py-3">
    <h2 className="font-semibold">FR24 access needs attention</h2>
    <p className="mt-1 text-sm">FR24 returned HTTP 402. This test session has stopped. There will be no further paid requests or automatic retries.</p>
    <p className="mt-1 text-sm text-muted">The FR24 account or API access issue must be resolved before another test can be authorized. No aircraft coverage was established by this response.</p>
    <button type="button" onClick={onHome} className="mt-3 min-h-11 rounded-md border border-border px-3 text-sm font-semibold">Back to search</button>
  </section>;
}

export function PreviewProviderStatus({ mode, session, providers }: {
  mode: "fr24-only" | "production-parity";
  session: NonNullable<FlightStory["providers"]>["fr24Preview"];
  providers?: FlightStory["providers"];
}) {
  const parity = mode === "production-parity";
  const stopped = session?.state === "stopped_402";
  const state = stopped ? "access stopped" : (session?.state ?? "unavailable").replaceAll("_", " ");
  const labels: Record<string, string> = { adsb: "ADS-B", fr24: "FR24", "flightaware-public": "FlightAware public", flightaware_public: "FlightAware public", flightstats: "FlightStats", fr24_live: "FR24", unavailable: "unavailable" };
  return <div role="status" className="border-b border-line px-4 py-2 text-sm text-muted">
    <strong>{parity ? "Production-source Preview" : "FR24-only Preview"}</strong> · FR24 {state}
    {session && <> · {session.creditsConsumed} / {session.creditCap ?? 0} credits reserved · {session.attempts} / {session.attemptCap ?? 0} attempts
      {session.expiresAt && <> · ends {new Date(session.expiresAt).toLocaleTimeString()}</>}
      {session.lastStatusCode && <> · HTTP {session.lastStatusCode}</>}
    </>}
    {parity ? <>
      <span className="block">Other configured sources and fallbacks remain active.</span>
      <span className="block">Position source: {labels[providers?.chosenPosition ?? "unavailable"] ?? providers?.chosenPosition}. Schedule source: {labels[providers?.scheduleSource ?? "unavailable"] ?? providers?.scheduleSource}.</span>
      {stopped && <span className="block">FR24 returned HTTP 402. Its paid requests remain stopped until account or API access is resolved; changing flights will not retry FR24.</span>}
    </> : <span className="block">Actual FR24 observations only. Missing or expired positions stay unavailable.</span>}
  </div>;
}
