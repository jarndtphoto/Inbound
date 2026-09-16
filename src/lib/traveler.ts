import { createElement } from "react";
import type { FlightStory } from "./types";
import { routeWeatherEvents } from "./weather-events";
import { passengerNextEvent } from "./next-event";

export const isLanded = (s: FlightStory) => s.currentStage === "gate" || s.times.landKind === "actual" || (s.currentStage === "arrival" && s.aircraft?.onGround === true);
export function journeyKey(s: FlightStory) {
  return [s.callsign, s.origin.icao, s.dest.icao, s.times.origPushUnix ?? s.times.origTakeoffUnix ?? new Date(s.fetchedAt).toISOString().slice(0,10)].join("|");
}

export function rideOutlook(s: FlightStory): string {
  const samples = s.route.samples;
  if (!samples.length) return "The projected ride is currently unavailable. We’re waiting for route weather data.";
  const current = samples.reduce((best, sample) =>
    Math.abs(sample.frac - s.route.progress) < Math.abs(best.frac - s.route.progress) ? sample : best, samples[0]);
  const incomplete = !s.weatherCoverage || s.weatherCoverage.failedSources.length > 0;
  let text = current.chop !== "smooth"
    ? "Projected ride is currently choppy."
    : current.convective
      ? "Storms are possible near the current route; the ride may be unsettled."
      : incomplete
        ? "Weather coverage is incomplete, so the current ride is uncertain."
        : "Projected ride is currently smooth, based on available forecasts.";

  const rank = { smooth: 0, light: 1, moderate: 2, severe: 3 } as const;
  const events = routeWeatherEvents(samples, s.route.progress);
  const strongest = events.reduce<(typeof events)[number] | null>((best, event) => {
    if (!best) return event;
    const eventRank = rank[event.start.chop] + (event.start.convective ? 0.5 : 0);
    const bestRank = rank[best.start.chop] + (best.start.convective ? 0.5 : 0);
    return eventRank > bestRank || (eventRank === bestRank && event.startEtaMin < best.startEtaMin) ? event : best;
  }, null);
  if (strongest) {
    const severity = strongest.start.chop === "severe" ? "Quite bumpy air"
      : strongest.start.chop === "moderate" ? "Moderate turbulence"
        : strongest.start.chop === "light" ? "Light turbulence"
          : "Storms near the route";
    const minutes = Math.max(0, Math.round(strongest.startEtaMin));
    text += minutes <= 1
      ? ` ${severity} is possible now.`
      : ` ${severity} is possible in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  } else if (!incomplete) {
    text += " No significant conditions are currently flagged ahead.";
  }
  if (incomplete && (current.chop !== "smooth" || current.convective)) text += " Weather coverage is incomplete.";
  return text;
}

export function RideOutlookText({ story }: { story: FlightStory }) {
  return createElement("span", null, rideOutlook(story));
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
  if ((s.currentStage as string) === "Takeoff roll") {
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
  const sameInstance=prev.flightId && next.flightId ? prev.flightId===next.flightId
    : prev.callsign===next.callsign && prev.origin.icao===next.origin.icao
      && prev.times.origPushUnix!=null && prev.times.origPushUnix===next.times.origPushUnix;
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
