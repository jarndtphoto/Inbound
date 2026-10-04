import { createElement } from "react";
import type { FlightStory } from "./types";
import { currentRideCoverageUncertain, flightWeatherSummary, upcomingWeatherEvents, weatherOutlook } from "./weather-presentation";
import { passengerNextEvent } from "./next-event";
import { operationalDepartureUnix, storyLegDate } from "./flight-story-date.ts";
import { orderedWeatherSamples } from "./route-weather-segments";

export const isLanded = (s: FlightStory) => s.currentStage === "gate" || s.times.landKind === "actual" || (s.currentStage === "arrival" && s.aircraft?.onGround === true);
export function journeyKey(s: FlightStory) {
  return [s.callsign, s.origin.icao, s.dest.icao, s.stateKey ?? storyLegDate(s) ?? new Date(s.fetchedAt).toISOString().slice(0,10)].join("|");
}

export function rideOutlook(s: FlightStory): string {
  const samples = s.route.samples;
  const summary = flightWeatherSummary(s);
  if (!samples.length) return `${summary}. The projected ride is currently unavailable. We’re waiting for route weather data.`;
  const ordered = orderedWeatherSamples(samples);
  const current = ordered.filter(sample => sample.frac <= s.route.progress).at(-1) ?? ordered[0] ?? samples[0];
  const incomplete = !s.weatherCoverage || s.weatherCoverage.failedSources.length > 0;
  const currentCoverageUncertain = currentRideCoverageUncertain(s.weatherCoverage);
  let text = currentCoverageUncertain
    ? "Weather coverage is incomplete, so the current ride is uncertain."
    : current.chop !== "smooth"
      ? "Projected ride is currently choppy."
      : current.convective
        ? "Storms are possible near the current route; the ride may be unsettled."
        : "Projected ride is currently smooth, based on available forecasts.";

  const highlights = weatherOutlook(upcomingWeatherEvents(samples, s.route.progress), s.dest?.city || s.dest?.iata || "");
  if (highlights.length) return [summary, ...highlights, text + (incomplete && (current.chop !== "smooth" || current.convective) ? " Weather coverage is incomplete." : "")].join("\n");
  if (!incomplete) text += " No significant conditions are currently flagged ahead.";
  if (incomplete && (current.chop !== "smooth" || current.convective)) text += " Weather coverage is incomplete.";
  return `${summary}\n${text}`;
}

export function RideOutlookText({ story }: { story: FlightStory }) {
  return createElement("span", null, ...rideOutlook(story).split("\n").map((line, index) =>
    createElement("span", { key: index, className: index ? "mt-1 block text-muted" : "block" }, line)));
}

export function nextStep(s: FlightStory, now = Date.now(), failed = false) {
  const age = Math.max(0, (now - s.fetchedAt) / 1000);
  const fixAge = (s.aircraft?.seenSec ?? Infinity) + age;
  const freshFix = s.live && !!s.aircraft && !s.aircraft.extrapolated && fixAge <= 30;
  const confidence = failed || age > 60 ? "Update delayed" : freshFix ? "Recent position available" : "Position not confirmed";
  if (s.diversion) {
    const destination=s.diversion.destination;
    const title=destination ? "Diverted to "+destination : "Diversion reported";
    const body=(destination ? "This flight diverted to "+destination+". " : "The updated arrival airport has not yet been confirmed by the flight feed. ")
      +(s.diversion.originalDestination ? "Originally bound for "+s.diversion.originalDestination+". " : "")
      +(isLanded(s) ? "Landing here does not confirm arrival at your intended destination. " : "")
      +"Check your airline for continuation or rebooking details. "
      +(failed || age > 60 || s.schedule?.status === "saved" ? "This is the last reported diversion; updates are delayed." : "");
    return {title,body:body.trim(),confidence};
  }
  if (failed || age > 60) return {title:"Waiting for a fresh update",body:"The information below is saved. Position, flight stage, and times may have changed.",confidence};
  if (s.currentStage === "takeoff_roll" || (s.currentStage as string) === "Takeoff roll") {
    return {
      title: "Takeoff roll underway",
      body: "The aircraft is accelerating on the runway. The flight will switch to airborne once takeoff is confirmed.",
      confidence,
    };
  }
  const event = passengerNextEvent(s);
  if (s.currentStage === "ride") return {...event, body:rideOutlook(s), confidence};
  if (s.currentStage === "taxi" || s.currentStage === "push") {
    const pushNote = s.times.pushSource === "provider_actual" && s.times.push
      ? ` Gate-out was reported at ${s.times.push}.`
      : "";
    return {
      ...event,
      body: `The aircraft has left the gate area and is heading toward the runway.${pushNote} Stops and holds on the way to the runway are normal.`,
      confidence,
    };
  }
  if (s.currentStage === "origin_gate") return {...event, body:`Your aircraft is at the departure airport. ${s.times.push ? "Gate departure is estimated around "+s.times.push+"." : "A gate-departure estimate is not available yet."} Scheduled times do not confirm movement.`, confidence};
  if (["gate", "taxi_in", "final_approach", "arrival"].includes(s.currentStage) || isLanded(s)) return {...event, confidence};
  if (s.inbound.status !== "complete") return {title:"Watching your inbound aircraft",body:s.inbound.detail || "We’re waiting for a reliable update on the aircraft assigned to your flight.",confidence};
  return {...event, body:`Your aircraft is reported at the departure airport. ${s.times.push ? "Gate departure is estimated around "+s.times.push+"." : "A gate-departure estimate is not available yet."} Scheduled times do not confirm movement.`,confidence};
}
export type AlertKind = "delay" | "gate" | "stage" | "diversion";
export type JourneyAlert = {kind: AlertKind; text: string; at: number};
export function journeyChanges(prev: FlightStory, next: FlightStory): JourneyAlert[] {
  if(next.fetchedAt<=prev.fetchedAt) return [];
  const departure=operationalDepartureUnix(prev);
  const sameInstance=prev.stateKey && next.stateKey ? prev.stateKey===next.stateKey
    : prev.flightId && next.flightId ? prev.flightId===next.flightId
    : prev.callsign===next.callsign && prev.origin.icao===next.origin.icao
      && departure!=null && departure===operationalDepartureUnix(next);
  if(next.diversion && sameInstance && (!prev.diversion || prev.diversion.destination!==next.diversion.destination)) {
    return [{kind:"diversion",text:nextStep(next,next.fetchedAt).title+". Check your airline for onward travel.",at:next.fetchedAt}];
  }
  if(journeyKey(prev)!==journeyKey(next)) return [];
  const out: JourneyAlert[]=[]; const add=(kind:AlertKind,text:string)=>out.push({kind,text,at:next.fetchedAt});
  const pd=prev.times.delayMin, nd=next.times.delayMin;
  if(!isLanded(next) && pd!=null && nd!=null && Math.abs(nd-pd)>=5) add("delay",`Departure delay ${nd>pd?"increased":"decreased"} by ${Math.abs(nd-pd)} minutes; now ${Math.max(0,nd)} minutes behind the original schedule. The specific cause is not confirmed.`);
  for(const [key,label] of [["originGate","Departure"],["destGate","Arrival"]] as const) {
    if(key==="originGate" && isLanded(next)) continue;
    const a=prev.times[key],b=next.times[key];
    if(a && b && a!==b) add("gate",`${label} gate changed from ${a} to ${b}. Check airport displays before heading there.`);
  }
  if(!isLanded(prev)&&isLanded(next)) add("stage",next.times.landKind === "actual" ? "Landing reported. Gate arrival is a separate event." : "Aircraft indicated on the ground at arrival; gate confirmation is pending.");
  if(prev.currentStage!=="gate"&&next.currentStage==="gate") add("stage",next.times.gateKind==="actual"?"Arrival at the gate reported.":"Aircraft appears parked; gate time is not confirmed.");
  if(prev.currentStage === "origin_gate" && (next.currentStage === "taxi" || next.currentStage === "push")) add("stage","Aircraft is heading to the runway.");
  if(!prev.times.airborne&&next.times.airborne&&!isLanded(next)) add("stage","Flight is now reported airborne.");
  return out;
}
