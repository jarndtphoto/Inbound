import { BaggageStatus } from "./baggage-status";
import { airlineStatusLink, flightDepartureDate } from "@/lib/airline-status";
import { useEffect, useState } from "react";
import type { FlightStory } from "@/lib/types";
import { isLanded, nextStep } from "@/lib/traveler";
export function TravelerCompanion({story, failed=false}:{story:FlightStory;failed?:boolean}) {
  const [now,setNow]=useState(story.fetchedAt);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),15000);setNow(Date.now());return()=>clearInterval(t)},[]);
  const step=nextStep(story,now,failed);
  const airlineLink=airlineStatusLink(story);
  let localTime="Local time unavailable";
  if(story.dest.tz)try{localTime=new Intl.DateTimeFormat(undefined,{timeZone:story.dest.tz,hour:"numeric",minute:"2-digit",timeZoneName:"short"}).format(now)}catch{}
  return <div className="mt-5 space-y-4">
    <section className="rounded-xl border border-border bg-surface p-5" aria-label="What happens next">
      <h2 className="text-xl font-semibold">{step.title}</h2><p className="mt-2 text-sm leading-relaxed">{step.body}</p>
      <p className="mt-3 text-xs text-muted">{step.confidence} · Updated {new Date(story.fetchedAt).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</p>
    </section>
    <section className="rounded-xl border border-border bg-surface p-5" aria-label="Arrival help">
      <h2 className="text-lg font-semibold">Arriving in {story.dest.city}</h2><p className="mt-1 text-sm text-muted">{localTime}</p>
      <dl className="mt-3 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-muted">Arrival gate</dt><dd className="mt-1 font-semibold">{story.times.destGate||"Not assigned"}</dd></div><div><dt className="text-muted">{story.times.gateKind==="actual"?"Reported gate arrival":"Estimated gate arrival"}</dt><dd className="mt-1 font-semibold">{story.times.gate||"Awaiting update"}</dd></div></dl>
      <div className="mt-4 border-t border-border pt-4">
        <p className="text-sm text-muted">Baggage carousel</p>
        <BaggageStatus flight={story.iata.replace(/\s/g, "")} origin={story.origin.iata} destination={story.dest.iata} date={flightDepartureDate(story)} />
        {airlineLink ? <>
          <a className="mt-3 inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm font-semibold underline" href={airlineLink.url} target="_blank" rel="noopener noreferrer">{airlineLink.direct ? "Check airline status for " + story.iata : "Search airline flight status"} ↗</a>
          {!airlineLink.direct && <p className="mt-2 text-xs text-muted">Search {story.iata} · {story.origin.iata} → {story.dest.iata}{airlineLink.date ? " · " + airlineLink.date : " · confirm departure date"}.</p>}
        </> : <p className="mt-2 text-xs text-muted">Check your airline app for {story.iata} · {story.origin.iata} → {story.dest.iata}. An official status link is not available here yet.</p>}
      </div>
      {isLanded(story)&&story.currentStage!=="gate"&&<p className="mt-3 text-sm">Landed; waiting for gate confirmation.</p>}
    </section>
  </div>;
}
