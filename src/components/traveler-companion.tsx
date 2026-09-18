import { inboundDiversionText } from "@/lib/inbound-diversion";
import { parseFlightQuery } from "@/lib/flight-parse";
import { airlineStatusLink } from "@/lib/airline-status";
import { getAirportSurfaceCached } from "@/lib/airport-surface";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useId } from "react";
import type { FlightStory } from "@/lib/types";
import { isLanded, nextStep, RideOutlookText } from "@/lib/traveler";
import { destinationGateTime } from "@/lib/passenger-time";

const SURFACE_CACHE_MS = 12 * 60 * 60_000;

function airportSurfaceQuery(airport: FlightStory["origin"]) {
  return {
    queryKey: ["airport-surface", airport.icao, airport.lat.toFixed(3), airport.lon.toFixed(3)] as const,
    queryFn: () => getAirportSurfaceCached({ airport: airport.icao, lat: airport.lat, lon: airport.lon }),
    staleTime: SURFACE_CACHE_MS,
    gcTime: SURFACE_CACHE_MS,
    retry: 1,
  };
}

export function TravelerCompanion({story, failed=false, onTrackInbound}:{story:FlightStory;failed?:boolean;onTrackInbound?:(flight:string)=>void}) {
  const queryClient=useQueryClient();
  const [now,setNow]=useState(story.fetchedAt);
  const [onward,setOnward]=useState("");
  const onwardId=useId();
  const onwardFlight=parseFlightQuery(onward);
  const validOnward=Boolean(onwardFlight && !onwardFlight.registration && onwardFlight.callsign!==parseFlightQuery(story.callsign)?.callsign);
  useEffect(()=>setOnward(""),[story.callsign,story.flightId]);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),15000);setNow(Date.now());return()=>clearInterval(t)},[]);
  useEffect(()=>{
    void queryClient.prefetchQuery(airportSurfaceQuery(story.origin));
    void queryClient.prefetchQuery(airportSurfaceQuery(story.dest));
  },[queryClient,story.origin.icao,story.origin.lat,story.origin.lon,story.dest.icao,story.dest.lat,story.dest.lon]);
  const step=nextStep(story,now,failed);
  const inbound=story.inbound.watch[0];
  const inboundFlight=inbound?.callsign ? parseFlightQuery(inbound.callsign) : null;
  const canTrackInbound=Boolean(onTrackInbound && inboundFlight && !inboundFlight.registration
    && inboundFlight.callsign!==parseFlightQuery(story.callsign)?.callsign
    && !inbound?.locked && ["airborne","watching","at_field"].includes(story.inbound.status)
    && ["inbound","push"].includes(story.currentStage) && !story.times.pushed);
  const airlineLink=airlineStatusLink(story);
  const gateArrivalTime=destinationGateTime(story.times.gateUnix,story.times.gate,story.dest.tz);
  return <div className="mt-5 space-y-4">
    {story.inboundDiversion && <section role="status" className="rounded-xl border border-accent bg-surface p-5" aria-label="Inbound aircraft diversion">
      <h2 className="text-xl font-semibold">Inbound aircraft was diverted</h2>
      <p className="mt-2 text-sm leading-relaxed">{inboundDiversionText(story.inboundDiversion)}</p>
      <p className="mt-3 text-sm text-muted">Aircraft {story.inboundDiversion.aircraft} · {story.inboundDiversion.chain.join(" → ")}</p>
      <p className="mt-2 text-xs text-muted">FlightAware history checked {new Date(story.inboundDiversion.reportedAt).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"})}.{failed || now-story.fetchedAt>60000 ? " Updates are delayed; this is the last confirmed history." : ""}</p>
    </section>}
    <section className="rounded-xl border border-border bg-surface p-5" aria-label="What happens next">
      <h2 className="text-xl font-semibold">{step.title}</h2><p className="mt-2 text-sm leading-relaxed">{story.currentStage === "ride" ? <RideOutlookText story={story} /> : step.body}</p>
      {story.diversion && onTrackInbound && <form className="mt-4 border-t border-border pt-4" onSubmit={event=>{event.preventDefault();if(validOnward && onwardFlight)onTrackInbound(onwardFlight.callsign);}}>
        <label htmlFor={onwardId} className="text-sm font-semibold">Track your onward flight</label>
        <p className="mt-1 text-sm text-muted">Enter the flight number supplied by your airline. A flight search does not confirm a booking or connection.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input id={onwardId} value={onward} onChange={event=>setOnward(event.target.value)} maxLength={16} placeholder="Flight number" className="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 text-fg" />
          <button type="submit" disabled={!validOnward} className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg disabled:opacity-50">Track onward flight</button>
        </div>
      </form>}
      {canTrackInbound && inboundFlight && <div className="mt-3">
        <p className="text-sm text-muted">Incoming flight: {inbound?.iata}{inbound?.from ? ` · From ${inbound.from}` : ""}</p>
        <button type="button" className="mt-2 min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg" onClick={()=>onTrackInbound?.(inboundFlight.callsign)}>Take me to inbound</button>
      </div>}
      <p className="mt-3 text-xs text-muted">{step.confidence} · Updated {new Date(story.fetchedAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</p>
    </section>
    {(!story.diversion || story.diversion.destination) && <section className="rounded-xl border border-border bg-surface p-5" aria-label="Arrival help">
      <h2 className="text-lg font-semibold">{story.diversion ? "Diversion airport: " : "Arriving in "}{story.dest.city}</h2><p className="mt-1 text-sm text-muted">{gateArrivalTime}</p>
      <dl className="mt-3 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-muted">Arrival gate</dt><dd className="mt-1 font-semibold">{story.times.destGate||"Not assigned"}</dd></div><div><dt className="text-muted">{story.times.gateKind==="actual"?"Reported gate arrival":"Estimated gate arrival"}</dt><dd className="mt-1 font-semibold">{gateArrivalTime}</dd></div></dl>
      <div className="mt-4 border-t border-border pt-4">
        {airlineLink ? <>
          <a className="mt-3 inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm font-semibold underline" href={airlineLink.url} target="_blank" rel="noopener noreferrer">{airlineLink.direct ? "Check airline status for " + story.iata : "Search airline flight status"} ↗</a>
          {!airlineLink.direct && <p className="mt-2 text-xs text-muted">Search {story.iata} · {story.origin.iata} → {story.dest.iata}{airlineLink.date ? " · " + airlineLink.date : " · confirm departure date"}.</p>}
        </> : <p className="mt-2 text-xs text-muted">Check your airline app for {story.iata} · {story.origin.iata} → {story.dest.iata}. An official status link is not available here yet.</p>}
      </div>
      {isLanded(story)&&story.currentStage!=="gate"&&<p className="mt-3 text-sm">Landed; waiting for gate confirmation.</p>}
    </section>}
  </div>;
}