# Part 3A.6: static Radar and Flights host proof

Source repository: `jarndtphoto/Inbound`, branch `plugin-v1-foundation`.
Isolated repository: `jarndtphoto/inbound-live-fixture-dev`, branch
`preview-host-test`. This stage builds on the approved source commit
`cb7b4df099d8e535c18aaf24f07fc440861b1a2f` and isolated fixture commit
`fd53fb59ad22bfd8ae3758a3359fa48ca83599d1`.

## Host evidence and next test

The user verified Part 3A.5 in their authenticated ChatGPT web account as
**Inbound Live Dev**: MCP connection, inline four-card UI, Chicago/ORD/MDW,
interactive controls, expanded/fullscreen display and advancing local ages.
That host did not advertise `pip`; Request PiP correctly stayed disabled.

Part 3A.6 adds the Radar UI. Its local component and simulated-host tests are
separate from the next user-run ChatGPT test. Do not sign into the user's
ChatGPT account, automate that host test, or change their existing connection.

Standard Vercel Authentication remains enabled on the isolated fixture project.
The separately approved public exception applies only to the previous immutable
Preview hostname `inbound-live-fixture-8lq158y26-jarndtphoto.vercel.app`.
A new Preview hostname requires separate approval before adding any exception.
Report the new protected URL and its access status; stop if it is not public.
After public MCP verification is separately approved and passes, the user will
need to update their Inbound Live Dev connection to the new `/mcp` URL.

## Radar and Flights

- Inline defaults to **Flights**. Fullscreen defaults to **Radar**.
- Each display mode remembers its chosen view in widget state where the host
  supports `window.openai.setWidgetState`; standalone local proof uses session
  storage. Both views share one selected aircraft ID.
- The dark radar surface uses local SVG/HTML/CSS, an approximate bundled Lake
  Michigan shoreline, Chicago context, and ORD/MDW airport markers.
- A north-up local equirectangular projection converts longitude difference to
  eastward nautical miles using the reference latitude's cosine; latitude
  difference supplies northward nautical miles. One scale serves both axes.
- The map fits the returned fixture positions and airport references within the
  selected area radius. No aircraft is hand-positioned in screen coordinates.
- Positions reuse the existing invented ranking-fixture observations, anchored
  to Chicago. Chicago, ORD and MDW recenter the map and recalculate named-reference
  distances without relocating aircraft or changing observation timestamps.
- Default areas each return all four fixtures. A smaller requested radius can
  return fewer; radius filtering happens before the presentation limit.
- The nearby contract contains no heading field. Neutral diamond symbols and
  explicit **Heading unavailable** labels preserve that uncertainty. The pure
  heading helper can orient a marker when an actual heading is available; this
  stage does not add one to the MCP contract or invent orientation.
- Marker and card selection stays synchronized through view switches and host
  state restoration. Selection makes no MCP request.
- The Radar summary shows identifier, route/hint or unavailable route, altitude,
  text vertical direction, motion, named-reference distance and observation age.
  **Track flight** is visibly disabled and has no tool or tracking handler.
- The Flights view retains four readable cards. On narrow screens, marker labels
  yield to the selected summary so the four 44px aircraft targets stay clear.
- Observation ages advance locally. Pause stops fixture refresh requests while
  ages continue advancing. Refresh calls only `fixture_get_nearby_flights` with
  `includePosition: true`. Aircraft disappear from both views after 120 seconds;
  an existing selection is explicitly marked expired.
- Static warnings remain visible. Aircraft positions never animate. No model
  turns, chat messages, geolocation, live tracking or detailed flight resolution
  are added. PiP remains capability-gated; no floating window is simulated.

## Fixture safety

- Exactly one read-only tool: `fixture_get_nearby_flights`.
- Exactly one UI resource: `ui://inbound/fixture-live-v1.html`.
- Resource MIME: `text/html;profile=mcp-app`.
- No provider, aviation API, weather/baggage, database, production Inbound API,
  production application UI, external HTTP client, map API or tile service ships.
- Only explicitly allowlisted pure modules and Zod enter the compiled bundle.
  The only external server import is `node:crypto`'s `randomBytes`.
- Build-time AST checks reject application outbound clients, socket/DNS/process
  imports, dynamic loading/code generation, unapproved endpoints, credential
  patterns and database URLs. The embedded UI is inspected separately; its only
  fetch is the existing localhost-only relative `/mcp` fallback. Host UI CSP
  advertises empty external connect/resource domains.
- Node/Vercel globals and builtins remain untouched. Zod uses interpreted
  validation and bundle-local configuration. Static isolation is deterministic
  application auditing, not a runtime or platform network firewall.
- Runtime requires `VERCEL_ENV === "preview"`, a valid `VERCEL_URL`, approved
  authorities/origins, and no sensitive provider/database environment settings.
  It fails closed after `2026-10-10T23:59:59.000Z`
  (October 10, 2026, 6:59:59 p.m. Chicago time).
- Responses retain `X-Inbound-Fixture-Only: true`,
  `X-Inbound-Egress: static-isolation` and `Cache-Control: no-store`.
- Each read has a new diagnostic read ID and per-process sequence; observations
  remain static. Logs contain only fixed methods, counters and policy labels.
- Deployment payload is exactly `api/mcp.js`, `package.json`, `vercel.json`.
  It contains no environment files, credentials, audit file, database setup,
  provider modules or repository-root package configuration.
- The source branch's existing root `vercel.json` disables automatic deployments
  for `plugin-v1-foundation`; it remains unchanged. Only the isolated repository's
  `preview-host-test` push should create this fixture Preview.

## Maintainer validation

Build with `node scripts/plugin-v1-preview-build.mjs`. Copy only the three payload
files from `artifacts/plugin-v1-fixture-preview` to
`deploy/plugin-v1-fixture-preview`, preserving bytes. Audit the dedicated directory
using `assertFixturePayload` in `scripts/plugin-v1-preview-isolation.mjs`.
`audit.json` remains local build evidence outside the deployable directory.

Run `npm run plugin:test` and `npm run typecheck`. The fixture suite includes
negative isolation cases, Node/Undici transport and instrumentation regressions,
production/configuration/expiry refusals, geometry, contracts and projection.
Tests retain the host-owned localhost proxy exemption while stripping application
configuration; no deployed environment variables are introduced.

Run `npm run plugin:browser-proof`, then
`npm run plugin:browser-proof -- --compiled`. If the test environment supplies a
Chromium binary outside Playwright's default cache, select that existing test
binary with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. It is a test-runner setting only.
The same browser assertions exercise source and the exact compiled payload:
selection, view/state persistence, local ages, refresh, lifecycle controls,
capability-gated PiP, accepted/declined fullscreen, desktop inline/expanded,
375px layout, accessible keyboard controls, zero external requests and expiry.

The existing direct MCP inspection suite runs through a real local HTTP server
in the compiled fixture regression test. It exercises initialize, discovery,
resource retrieval, Chicago/ORD/MDW/repeated reads and rejected mutations.
After separately approved public access, inspect the exact HTTPS endpoint with:

```
node scripts/plugin-v1-mcp-inspect.mjs VERIFIED_HTTPS_MCP_URL EVIDENCE_JSON_PATH
```

## User-run host test after public verification

In the user's existing Inbound Live Dev connection, use the newly verified public
`/mcp` URL. Open Inbound Live for Chicago, expand it, and confirm Radar defaults
open with four invented observations. Try ORD/MDW, marker/card selection, switching
views, Pause/Resume and refresh. Confirm the disabled Track flight action, static
positions, local ages and capability-gated PiP. Actual mobile ChatGPT remains a
separate host test; a 375px simulation is responsive QA only.

## Restore protection and remove the proof

After host testing, remove only the approved hostname from the isolated project's
**Deployment Protection Exceptions → Unprotected Domains → Menu → Remove**.
Standard Protection remains enabled. The exception does not expire automatically;
the fixture's application expiration does not remove that protection exception.

The user can disconnect Inbound Live Dev in ChatGPT. Removing the isolated fixture
Preview/project is a separate action. Real Inbound, both repositories' main
branches, merges, production deployments and Part 3B remain outside this stage.
