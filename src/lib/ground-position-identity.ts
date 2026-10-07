type Identity = { hex?: string | null; registration?: string | null; callsign?: string | null };
const registrationKey = (value?: string | null) => String(value ?? "").replace(/[-\s]/g, "").toUpperCase();
const hexKey = (value?: string | null) => String(value ?? "").replace(/^~+/, "").toLowerCase();

/** Never combine a current tail assignment with the previous aircraft's cached hex. */
export function resolveGroundIdentity(current: Identity, saved: Identity | null) {
  const registrationChanged = Boolean(current.registration && saved?.registration
    && registrationKey(current.registration) !== registrationKey(saved.registration));
  const hexChanged = Boolean(current.hex && saved?.hex && hexKey(current.hex) !== hexKey(saved.hex));
  // If a new registration is supplied but the cache cannot establish its tail,
  // its hex has no provenance tying it to the new assignment either.
  const unprovenTail = Boolean(current.registration && saved?.hex && !saved.registration);
  const compatible = !registrationChanged && !hexChanged && !unprovenTail;
  return {
    hex: current.hex ?? (compatible ? saved?.hex : null) ?? null,
    registration: current.registration ?? (compatible ? saved?.registration : null) ?? null,
    callsign: current.callsign ?? (compatible ? saved?.callsign : null) ?? null,
  };
}
