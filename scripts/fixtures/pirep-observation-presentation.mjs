import { polishStory } from './presentation-polish.mjs';

export const PIREP_PRESENTATION_NOW = Date.UTC(2026, 9, 4, 3);
export const PIREP_PRESENTATION_DESCRIPTION = 'Synthetic UA203-style presentation replay, not a captured UA203 flight. Frozen at 2026-10-04T03:00:00Z; another aircraft reported moderate turbulence one hour earlier in an area this fixture reaches six hours later. The legacy input incorrectly forecast that report across a 16-minute route segment. All coordinates, flight clocks and provider-independent display inputs are fixtures; no live provider requests.';

export function pirepPresentationStory({ mixed = false, ageMs = 60 * 60_000, untimed = false } = {}) {
  const base = polishStory(), now = PIREP_PRESENTATION_NOW;
  const report = { id: 'synthetic-moderate-report', chop: 'moderate',
    observedAt: untimed ? null : now - ageMs, detail: 'Synthetic pilot report: moderate turbulence observed by another aircraft.' };
  const point = (frac, etaMin, chop = 'smooth', note = null, pilotReports = []) => ({
    frac, etaMin, lat: 41.9786 - 20.6599 * frac, lon: -87.9048 - 70.0177 * frac,
    distNm: frac * 3690, remainingNm: (1 - frac) * 3690,
    chop, convective: false, cloud: false, note, fix: false, pilotReports,
  });
  const reportPoint = point(.75, 360, mixed ? 'moderate' : 'smooth', mixed ? 'SIGMET moderate turbulence advisory.' : null, [report]);
  const takeoff = now / 1000 - 50 * 60, push = takeoff - 20 * 60, landing = now / 1000 + 420 * 60;
  return {
    ...base, fetchedAt: now, query: 'UA203', callsign: 'UAL203', iata: 'UA203',
    stateKey: 'leg:v1:UAL203|2026-10-03|ORD|HNL',
    times: { ...base.times, pushUnix: push, takeoffUnix: takeoff, landUnix: landing, gateUnix: landing + 600,
      origPushUnix: push - 600, origTakeoffUnix: takeoff - 600, origLandUnix: landing,
      push: '8:50 PM CDT', takeoff: '9:10 PM CDT', land: '12:00 AM HST', gate: '12:10 AM HST' },
    route: { ...base.route, etaMin: 420, samples: [point(.1, 0), reportPoint, point(.79, 376), point(1, 420)] },
    hazards: [{ id: report.id, kind: 'pirep', source: 'observed', chop: report.chop,
      label: 'Moderate turbulence reported', detail: report.detail, observedAt: report.observedAt,
      remaining: true, lat: reportPoint.lat, lon: reportPoint.lon,
    }, ...(mixed ? [{ id: 'synthetic-advisory', kind: 'turb', source: 'advisory', chop: 'moderate',
      label: 'Moderate turbulence possible', detail: 'Synthetic SIGMET moderate turbulence advisory.',
      validity: 'Synthetic advisory validity window', remaining: true, lat: reportPoint.lat, lon: reportPoint.lon }] : [])],
    wx: { hash: 'synthetic-observation-presentation', deltas: [], filedAt: now, filed: {},
      live: { worstChop: mixed ? 'moderate' : 'smooth', convective: false, corridor: [] } },
  };
}
