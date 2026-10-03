# PR #35: durable unvalidated legs

Fixture audit uses the actual FlightAware/FlightStats parsers and the actual
FR24-only server aggregation. All provider responses are mocked.

| Fixture | Canonical key today | Rejection | Durable key |
| --- | --- | --- | --- |
| UA219 FlightAware handoff record | `leg:v1:UAL219|2026-10-02|ORD|HNL` | none | canonical |
| UA219 FlightStats fallback HTML | `leg:v1:UAL219|2026-10-02|ORD|HNL` | none | canonical |
| FR24-only surface record without scheduled clocks | none | `missing_scheduled` | `leg:unvalidated:UAL219|ORD|HNL|2026-10-02` |

The UA219 record/HTML are reconstructed from the earlier Preview observation.
The FR24 surface fixture is synthetic and explicitly labeled as such.

`scripts/flight-identity-replay.test.mjs` reimports the server bundle to discard
module memory between polls while retaining the database. It observes Pushback,
then Taxiing out, then retains Taxiing out at 0 kt in another cold instance.
The persisted first push is 1790952850; taxi is recorded at 1790952860. Gaining
the dated schedule carries both facts into the canonical row. The fallback row
stays intact. Five story polls make five existing FR24 live lookups; no track or
summary requests, credentials, or live provider traffic are used.

Store regressions cover fallback-to-canonical carry-forward in both tables,
including fallback updates after a canonical row already exists. Phase state
uses mergeForward/version CAS; arrival state keeps a complete winning path with
CAS. Unchanged carry-forward does not rewrite phase state. Different dates and
routes stay isolated, including an origin-local/UTC midnight boundary.

Unavailable canonical keys log `canonical_leg_key_unavailable` with one of
`missing_scheduled`, `route_mismatch`, `service_date_mismatch`, or `no_ident`.
The response exposes the selected flightStateKey, canonicalKey, and failure.
Fallback dates retain origKey's clock selection and UTC day, including its
eight-hour slip rule and "now" only when no departure clock exists. Promotion
matches the scheduled UTC day; neighboring days are never guessed.

Device-only resumes cannot save or carry legacy rows into shared state. Existing
device-isolation regressions remain active. No stage-classification,
takeoff-floor, shared-cache, cruise-polling, or migration changes are included.
