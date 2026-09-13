// A bounded fallback for a recently verified, unfinished flight instance.
export function recentScheduleFallback(value: any, fetchedAt: number, now = Date.now()) {
  if (!value || !Number.isFinite(fetchedAt) || now < fetchedAt || now - fetchedAt > 120_000) return null;
  if (value.cancelled || value.gateIn?.actual || value.landing?.actual) return null;
  if (!(value.originIata || value.originIcao) || !(value.destIata || value.destIcao)) return null;
  const departure = value.takeoff?.actual ?? value.gateOut?.actual ?? value.gateOut?.estimated ?? value.gateOut?.scheduled;
  if (!Number.isFinite(departure) || departure < now / 1000 - 18 * 3600 || departure > now / 1000 + 24 * 3600) return null;
  return { ...value, scheduleStaleAt: fetchedAt, faTrack: [], inbound: null, inboundIdent: null, inboundFlightId: null };
}
export function bootstrapPayload(html: string) {
  const assignment = /\btrackpollBootstrap\s*=\s*/.exec(html);
  return assignment ? html.slice(assignment.index + assignment[0].length) : null;
}
