import type { FlightStory } from "./types";

export const isLanded = (s: FlightStory) => s.currentStage === "gate" || s.times.landKind === "actual" || (s.currentStage === "arrival" && s.aircraft?.onGround === true);
export function journeyKey(s: FlightStory) {
  return [s.callsign, s.origin.icao, s.dest.icao, s.times.origPushUnix ?? s.times.origTakeoffUnix ?? new Date(s.fetchedAt).toISOString().slice(0,10)].join("|");
}
export function nextStep(s: FlightStory, now = Date.now(), failed = false) {
  const age = Math.max(0, (now - s.fetchedAt) / 1000);
  const fixAge = (s.aircraft?.seenSec ?? Infinity) + age;
  const freshFix = s.live && !!s.aircraft && !s.aircraft.extrapolated && fixAge <= 30;
  const confidence = failed || age > 60 ? "Update delayed" : freshFix ? "Recent position available" : "Position not confirmed";
  if (failed || age > 60) return {title:"Waiting for a fresh update",body:"The information below is saved. Position, flight stage, and times may have changed.",confidence};
  if (s.currentStage === "gate") return {title:s.times.gateKind === "actual" ? "You’ve reached your destination gate" : "Aircraft appears parked",body:s.times.gateKind === "actual" ? "Gate arrival has been reported. Check airport displays for baggage and onward travel." : "The app indicates the aircraft is parked. An actual gate-arrival time is not yet confirmed.",confidence};
  if (isLanded(s)) return {title:"Awaiting gate confirmation",body:"Your flight has landed. We’re watching for the gate-arrival report; a stopped or disappearing radar signal alone does not confirm arrival at the gate.",confidence};
  if (s.currentStage === "arrival") return {title:"Landing is next",body:`Landing ${s.times.land ? "is estimated around "+s.times.land : "time is not yet available"}. Gate arrival follows taxi-in.`,confidence};
  if (s.currentStage === "ride") return {title:"En route to "+s.dest.city,body:"Check Weather for significant conditions ahead. Timing changes with the route, altitude, and speed.",confidence};
  if (s.currentStage === "taxi" || s.times.pushed) return {title:"Takeoff is next",body:s.times.pushKind === "actual" ? `Pushback was reported${s.times.push ? " at "+s.times.push : ""}. Takeoff time remains an estimate until confirmed.` : "Ground movement has been indicated. An exact pushback time is not yet confirmed.",confidence};
  if (s.inbound.status !== "complete") return {title:"Watching your inbound aircraft",body:s.inbound.detail || "We’re waiting for a reliable update on the aircraft assigned to your flight.",confidence};
  return {title:"Waiting for pushback",body:`Your aircraft is reported at the departure airport. ${s.times.push ? "Pushback is estimated around "+s.times.push+"." : "A pushback estimate is not available yet."} Scheduled times do not confirm movement.`,confidence};
}
export type AlertKind = "delay" | "gate" | "stage";
export type JourneyAlert = {kind: AlertKind; text: string; at: number};
export function journeyChanges(prev: FlightStory, next: FlightStory): JourneyAlert[] {
  if(journeyKey(prev)!==journeyKey(next) || next.fetchedAt<=prev.fetchedAt) return [];
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
  if(!prev.times.pushed&&next.times.pushed&&!isLanded(next)) add("stage",next.times.pushKind==="actual"?"Pushback reported.":"Ground movement indicated.");
  if(!prev.times.airborne&&next.times.airborne&&!isLanded(next)) add("stage","Flight is now reported airborne.");
  return out;
}
