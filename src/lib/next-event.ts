import type { FlightStory } from "./types";

export type PassengerNextEvent = { title: string; body: string };

export function passengerNextEvent(s: FlightStory): PassengerNextEvent {
  const stage = s.currentStage;
  const landed = s.times.landKind === "actual"
    || stage === "taxi_in"
    || stage === "gate"
    || ((stage === "arrival" || stage === "final_approach") && s.aircraft?.onGround === true);

  if (stage === "gate") {
    return s.times.gateKind === "actual"
      ? { title: "You’ve reached your destination gate", body: "Gate arrival has been reported. Check airport displays for baggage and onward travel." }
      : { title: "Aircraft appears parked", body: "The app indicates the aircraft is parked. An actual gate-arrival time is not yet confirmed." };
  }
  if (stage === "taxi_in") return { title: "At the gate is next", body: "The aircraft is taxiing in. Gate arrival will be shown once it is confirmed or the aircraft is clearly parked." };
  if (landed) return { title: "Taxiing in is next", body: "Your flight has landed and is completing its runway rollout before taxiing to the gate." };
  if (stage === "final_approach") {
    return { title: "Landing is next", body: `Landing ${s.times.land ? `is estimated around ${s.times.land}` : "time is not yet available"}. Gate arrival follows taxi-in.` };
  }
  if (stage === "arrival") return { title: "Final approach is next", body: `The flight is approaching ${s.dest.city}. Landing follows final approach.` };
  if (stage === "ride") return { title: `En route to ${s.dest.city}`, body: "" };
  if (stage === "taxi" || stage === "push") return { title: "Takeoff is next", body: "" };
  if (stage === "origin_gate") return { title: "Heading to runway is next", body: "" };
  return { title: "Waiting for departure movement", body: "" };
}
