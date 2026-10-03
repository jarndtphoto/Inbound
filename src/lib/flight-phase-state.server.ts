import { getSql } from "./db";
import { createFlightPhaseStateStore } from "./flight-phase-state-store.server.ts";
export type { PhaseState, PushLatch, TaxiOutLatch, ConfirmedTakeoff, LoadResult, SaveStatus } from "./flight-phase-state-store.server.ts";
export { phaseStateEqual } from "./flight-phase-state-logic";
// Preserve eager DB bootstrap; the injected factory exercises real CAS in tests.
const store = createFlightPhaseStateStore(getSql);
export const loadPhaseState = store.load;
export const savePhaseState = store.save;
