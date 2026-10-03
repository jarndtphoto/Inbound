// Deterministic presentation replay: no live provider calls or server stage changes.
export function polishStory() {
  const fetchedAt = Date.UTC(2026, 9, 3, 14, 6);
  const stamp = (scheduled, actual = null) => ({ scheduled, estimated: null, actual });
  const push = fetchedAt / 1000 - 3600, takeoff = push + 1200, landing = fetchedAt / 1000 + 5 * 3600;
  const sample = (frac, etaMin, chop) => ({ frac, etaMin, lat: 41.98 - 20.66 * frac, lon: -87.9 - 70.02 * frac, chop, convective: false, cloud: false, note: null });
  return {
    stateKey: 'leg:v1:UAL219|2026-10-03|ORD|HNL', fetchedAt, query: 'UA219', callsign: 'UAL219', iata: 'UA219', airline: 'United',
    live: true, currentStage: 'ride',
    aircraft: { lat: 40, lon: -94.9, onGround: false, altFt: 33000, gsKt: 480, seenSec: 1, track: 250, type: 'B772', typeName: 'Boeing 777', registration: 'N219UA' },
    providers: { chosenPositionAgeSec: 1 }, weatherCoverage: { failedSources: [] },
    origin: { iata: 'ORD', icao: 'KORD', city: 'Chicago', name: 'O’Hare', lat: 41.9786, lon: -87.9048, tz: 'America/Chicago', rawMetar: '', taf: null },
    dest: { iata: 'HNL', icao: 'PHNL', city: 'Honolulu', name: 'Daniel K. Inouye', lat: 21.3187, lon: -157.9225, tz: 'Pacific/Honolulu', rawMetar: '', taf: null },
    times: { push: '8:06 AM CDT', pushUnix: push, pushKind: 'actual', pushSource: 'provider_actual', pushed: true,
      takeoff: '8:26 AM CDT', takeoffUnix: takeoff, takeoffKind: 'actual', airborne: true,
      land: '9:06 AM HST', landUnix: landing, landKind: 'scheduled',
      gate: '9:16 AM HST', gateUnix: landing + 600, gateKind: 'scheduled',
      origPushUnix: push - 600, origTakeoffUnix: takeoff - 600, origLandUnix: landing,
      taxiOutMin: 20, taxiOutKind: 'measured', taxiInMin: 10, taxiInKind: 'filed', originGate: 'B12', destGate: 'C4', delayMin: 10 },
    resume: { gateOut: stamp(push - 600, push), takeoff: stamp(takeoff - 600, takeoff), landing: stamp(landing), gateIn: stamp(landing + 600) },
    route: { progress: 0.1, totalNm: 3690, remainingNm: 3300, flownNm: 390, heading: 250, etaMin: 300, source: 'direct',
      samples: [sample(0.1, 0, 'smooth'), sample(0.13, 11, 'light'), sample(0.2, 21, 'smooth'), sample(0.7, 228, 'moderate'), sample(0.8, 248, 'smooth'), sample(1, 300, 'smooth')] },
    inbound: { watch: [], headline: 'At the gate', detail: '', status: 'complete' },
    comfort: { score: 90, grade: 'A', label: 'On time', summary: '', reasons: [] },
    hazards: [], stages: Object.fromEntries(['inbound', 'origin_gate', 'push', 'taxi', 'ride', 'arrival', 'final_approach', 'taxi_in', 'gate'].map(id => [id, { state: id === 'ride' ? 'now' : 'next', title: id, detail: '' }])),
  };
}

export function actualOnlyStory() {
  const story = polishStory();
  const actual = story.fetchedAt / 1000 - 300;
  return { ...story, currentStage: 'taxi_in', live: false, aircraft: null,
    times: { ...story.times, origPushUnix: story.times.pushUnix, origTakeoffUnix: story.times.takeoffUnix,
      origLandUnix: actual, landUnix: actual, land: '4:01 AM HST', landKind: 'actual', airborne: false,
      gateUnix: actual + 600, gate: '4:11 AM HST', gateKind: 'estimated', pushWas: 'untrusted', landWas: 'untrusted' },
    resume: { gateOut: { scheduled: null }, takeoff: { scheduled: null }, landing: { scheduled: null }, gateIn: { scheduled: null } },
  };
}
