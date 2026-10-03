# Part 3A.5: user-run ChatGPT fixture test

Foundation: `f852f79ba12485c5d6cae9b31a3b59e9858fc82f`, branch `plugin-v1-foundation`.

## Deployment status

The isolated private repository `jarndtphoto/inbound-live-fixture-dev` has a
protected Preview on `preview-host-test`. The initial deployment built on Node
22 but failed function invocation with no exception/stack exposed by Vercel.
Process-wide patches independently broke local Undici loopback transport and
runtime instrumentation; the exact original deployed exception is unconfirmed.
The replacement removes those patches and audits the static fixture payload.
Deployment Protection remains enabled. Do not connect ChatGPT until a separate
public-access step is approved and verified.

Secure MCP Tunnel was considered first. This environment has no tunnel ID,
runtime API key, or tunnel client. No credentials were requested.

The prepared fallback targets a new, isolated project named
`inbound-live-fixture-dev`, with a **Preview** deployment only. No existing Inbound
project configuration, environment variables, domains, database, or provider
modules are included. The deployment payload consists of only `api/mcp.js`,
`package.json`, and `vercel.json` from the explicit fixture build.

## Safety and verification

- One read-only tool: `fixture_get_nearby_flights`.
- One resource: `ui://inbound/fixture-live-v1.html`.
- Resource MIME: `text/html;profile=mcp-app`.
- No real single-flight lookup, selection resolution, provider acquisition,
  production API, database, or persistent server state.
- Fixture aircraft, routes, and observation timestamps remain static.
- Each tool read includes a new diagnostic read ID and a per-process sequence.
  These are test metadata; they do not refresh observation timestamps.
- Only explicitly allowlisted pure modules and Zod enter the compiled bundle.
- Preview runtime rejects production execution, provider/database configuration,
  unexpected authorities/origins, and requests after the temporary test window.
- The final server bundle permits only `node:crypto`'s `randomBytes` import.
  Build-time AST checks reject application fetch/WebSocket, HTTP clients,
  socket/DNS/subprocess imports, dynamic loading/code generation, unapproved
  endpoints, credential patterns and database URLs. Zod uses interpreted
  validation and bundle-local configuration. Node/Vercel globals are untouched.
- The embedded unchanged UI is checked separately: its sole fetch is the
  existing localhost-only relative `/mcp` read. Host UI CSP has empty external
  connect/resource domains. No provider or production API endpoints are shipped.
- The three-file directory is audited for exact file names and dependency-free
  package/deployment configuration. Negative safety fixtures must fail the same
  audit used by the build. This is deterministic static isolation, not a runtime
  or platform network firewall. Headers report `X-Inbound-Egress: static-isolation`.
- Request logs contain only fixed method names, counters and the static policy
  name. Request arguments, account data and credentials are not logged.
- MCP uses HTTP POST for read-only JSON-RPC; it exposes no mutation tools.
- Equivalent direct MCP inspection is available in
  `scripts/plugin-v1-mcp-inspect.mjs`. Public HTTPS verification is pending.

The runtime-fix regression suite includes the existing 77 tests and three
additional compiled-payload isolation/HTTP tests. The compiled
fixture bundle is inspected with 43 independent direct MCP checks, including four tool
reads and Chicago/ORD/MDW inputs. Source and compiled widget rendering pass at
1280×800 and 390×844 with four cards, no horizontal overflow, and no console/page
errors. The existing component/mock-host suite passes 12 assertions. None of
these results constitutes real ChatGPT or actual mobile host verification.

## User connection steps, after a verified URL is supplied

1. Open your normal, already logged-in **ChatGPT web** account.
2. Open **Settings** → **Security and login**.
3. Enable **Developer mode**.
4. Go to **ChatGPT Plugins** and press **+**.
5. Name: **Inbound Live Dev**.
6. Description: **Static fixture-only Inbound Live UI test. No real aircraft.**
7. Under **Connection**, choose the public URL option and paste the verified
   HTTPS URL ending in `/mcp`. Select no authentication if asked.
8. Create/connect it. It should discover exactly `fixture_get_nearby_flights`.
9. Start a new conversation. Select **Inbound Live Dev** from the tools menu
   (**+** → **More** where offered).
10. Send: **Open Inbound Live.**

If asked for an area, choose **Chicago**. The proof also supports **ORD** and **MDW**.
Developer mode availability depends on your account and workspace policy.
These instructions follow official documentation; no signed-in account UI was
inspected during this setup task. No real-host verification is claimed.

## What to try

- Confirm four cards, the area label, route hint, altitude/trend, named-reference
  distance, age labels, and local aircraft selection.
- Open **About this proof**. Watch the refresh count and server read ID. A changed
  read ID proves a new fixture response; age ticks alone do not.
- Try **Request PiP**, then send an unrelated message. Record what actually stays
  visible. A disabled button means the bridge did not advertise that capability.
- Try **Pause**, **Resume**, **Expand**, area changes, selection, and dismissal.
- Mobile ChatGPT is a separate host test; responsive browser QA is not evidence.

## Known limits

- All aviation facts are invented; no real Nearby backend exists in this proof.
- Cards age out after 120 seconds. Refresh intentionally does not reset their
  ages. A fresh host widget/session may be required for another test; host state
  retention is itself unverified.
- Selection focuses a fixture locally. Detailed flight navigation and Back to
  Live are not implemented in this proof.
- PiP, fullscreen, direct refresh, mounting and state retention are host-gated
  and remain unverified until the user tests them.
- The read sequence can restart on a Vercel cold start. Use the unique read ID
  alongside it.
- The prepared server fails closed after `2026-10-10T23:59:59.000Z`
  (October 10, 2026, 6:59:59 p.m. Chicago time). Expiry disables serving; it does
  not delete the deployment or project.
- Preview Deployment Protection must permit ChatGPT's requests before a URL is
  supplied. No protection setting has been changed.

## Removal

Remove/disconnect **Inbound Live Dev** in ChatGPT Plugins. Then delete only the
isolated fixture Preview deployment in Vercel. The production `inbound` project
must remain untouched. Expiry also disables this fixture server automatically.

## Maintainer build and inspection

Build only the fixture payload with `node scripts/plugin-v1-preview-build.mjs`.
The output is `artifacts/plugin-v1-fixture-preview`; the exact three files are
copied byte-for-byte to `deploy/plugin-v1-fixture-preview`. Audit that dedicated
directory with `assertFixturePayload` from `scripts/plugin-v1-preview-isolation.mjs`.
Do not deploy the repository
root or the root `.vercel/output` directory. `audit.json` is local evidence and is
not part of the three-file deployment payload.

After the Preview is reachable, inspect its exact URL with:

```
node scripts/plugin-v1-mcp-inspect.mjs VERIFIED_HTTPS_MCP_URL EVIDENCE_JSON_PATH
```

Do not provide the URL to the user until the public, unauthenticated HTTPS
inspection passes. This task does not authorize Part 3B, main-branch merge,
production deployment, or automated ChatGPT authentication/host testing.

Official setup documentation:
https://developers.openai.com/plugins/deploy/connect-chatgpt

Official tunnel documentation:
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
