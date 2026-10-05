import type { StageId, StageStepId } from "./types.ts";

export const FLIGHT_STAGES: { id: StageStepId; label: string }[] = [
  { id: "inbound", label: "Inbound" }, { id: "origin_gate", label: "At gate" },
  { id: "push", label: "Pushback" }, { id: "taxi", label: "Taxiing out" },
  { id: "ride", label: "Flight" }, { id: "arrival", label: "Arrival" },
  { id: "final_approach", label: "Final approach" }, { id: "taxi_in", label: "Taxiing in" },
  { id: "gate", label: "At the gate" },
];
const progress: Record<StageId, number> = {
  inbound: 0, origin_gate: 0, push: 1, taxi: 2, takeoff_roll: 2,
  ride: 3, arrival: 4, final_approach: 4, taxi_in: 5, gate: 5,
};
/** Accept older device caches while all new stories emit machine ids. */
export function flightStageId(value: string): StageId {
  if (value === "Takeoff roll") return "takeoff_roll";
  if (value === "ground") return "origin_gate";
  return Object.hasOwn(progress, value) ? value as StageId : "inbound";
}
export function stageStepId(value: string): StageStepId {
  const stage = flightStageId(value);
  return stage === "takeoff_roll" ? "taxi" : stage;
}
export const statusProgressIndex = (stage: StageId) => {
  const id = flightStageId(stage);
  return id === "taxi_in" ? 4 : progress[id];
};
