# Part 3B.1 isolated development verification — 2026-10-04 UTC

Branch: `plugin-v1-nearby-acquisition`, unmerged. Base main:
`47e4bdf075c5c6acba8ae8195c5a87f9990c3c3a`.
This report does not certify a completed live PostgreSQL run.

## Completed cleanup

- Removed `src/lib/traffic-motion.ts`. A search of all source and scripts found no imports or references. Nearby already uses main's shared `aircraft-phase.ts`.
- Added `plugin-v1-nearby-acquisition: false` to `vercel.json` → `git.deploymentEnabled`, alongside the existing foundation guard.
- Added `scripts/nearby-postgres-verify.mjs`, a verification-only harness. It has no provider, acquisition, migration, deployment or default `DATABASE_URL` path.
- Corrected the historical README paragraph about the removed helper. Fixture MCP sources and entry points are unchanged by this cleanup.

## Automatic deployment audit

Earlier pushes had created these Vercel Previews (all reported READY by the control plane):

| Commit | Deployment ID | Preview URL |
|---|---|---|
| d49d5ee | dpl_8Bg8rKjNzN4TBzSsxD83KxS6r3Ls | https://inbound-q11lbavpm-jarndtphoto.vercel.app |
| c3b8439 | dpl_49LPowawWYkH6sSBsNkzDhBBUdAg | https://inbound-4fdwsl9vn-jarndtphoto.vercel.app |
| d6ef464 | dpl_DmkCwW5P6VyEimbhZBi6hzLThx3c | https://inbound-a5vx4ly1y-jarndtphoto.vercel.app |

The user requested listing these deployments, not deleting them. Their app routes were not visited during verification.

Deleted the matching Neon `preview/plugin-v1-nearby-acquisition` branch and confirmed it absent after reloading the inventory. Other branches were left alone, including the separate 3B.1.5 and 3B.1.6 verification branches and the 3B.1.5 Preview.

## Neon development target: blocked

Project: `inbound-db` / `withered-water-48367194`.
Excluded main branch: `br-late-forest-au7csk9x`.

Requested target `plugin-v1-dev`: **not created; no branch ID or endpoint exists**.
The schema-only Console form accepted the name, main parent and branch type,
briefly disabled its controls, then returned to the same enabled form without
an error. Refreshed branch inventory still contains four other branches and no
`plugin-v1-dev`. No duplicate target was created.

A standard data-and-schema creation attempt was rejected before submission by
automatic approval review because it would copy main data. It was not bypassed.

Consequently `docs/plugin-v1/migrations/0006_nearby_collection.sql` has **not**
been applied in this task to any branch, and no live database store test has run.
Earlier verification on differently named branches is not evidence for the
requested target or this cleanup commit.

## Prepared real-connection verification

The harness defaults to 100 independently connected clients, requires 100
distinct `pg_backend_pid()` values, and uses separate SQL adapters for the actual
`createNearbyCollectionStore`. It requires explicitly pinned branch name/ID,
unpooled host and database, with no fallback to a general database URL.

| Requested group | Prepared functional assertions | Live execution |
|---|---:|---|
| Concurrent DB-clock claims, exactly one winner | 7 | Not run |
| Expired lease rejects publication | 5 | Not run |
| Expired replacement fences stale/duplicate writers | 9 | Not run |
| Backoff 20/40/80/120/120 s, safe-state retention and reset | 47 | Not run |
| Inactive retention, scoped cleanup and view cascade | 11 | Not run |
| Total | 79 across 5 groups | 0 executed |

Harness syntax and missing-target refusal were checked. Independent read-only
review confirmed its session isolation, test scope and run-scoped cleanup.
Only six unique synthetic verification environments can be cleaned up.
No real flight observations are used.

Run only after independently associating a new `plugin-v1-dev` branch with its
unpooled endpoint and applying 0006 there. The documented optional official Neon
WebSocket driver is temporary and outside the repository; no dependency was added.

## Sequential check and build

1. Standard `env -u DATABASE_URL npm run check`: typecheck passed; 856 tests,
   853 passed, 2 failed, 1 existing TODO.
2. Both failures are unchanged UTC-sensitive UA219 replay tests:
   `route-memory-replay.test.mjs` and `takeoff-floor-replay.test.mjs`.
   They mock `Date.now()` to October 2 while FlightStats date discovery uses
   native `new Date()`. After UTC midnight on October 4 its today/yesterday/
   tomorrow window excludes their October 2-only fixture. These tests and
   `story.server.ts` are identical to current main.
3. Repeated `npm run check` using a temporary external preload that makes
   zero-argument `new Date()` use the already-mocked `Date.now()`: typecheck
   passed; **856 tests, 855 passed, 0 failed, 1 existing TODO**. No test or app
   clock change was committed. This is a qualified result, not an unmodified
   green standard check.
4. Then `env -u DATABASE_URL npm run build`: passed. The migration hook reported
   `DATABASE_URL not set — skipping`. Build made no shared database connection.

## Smoke and isolation

Real aviation smoke: **not run**. Calls: adsb.fi 0, adsb.lol 0,
airplanes.live 0; FR24 0; FlightAware 0; other providers 0. No acquired raw,
fused or rejected counts or payload bytes exist to report.

Main stayed at `47e4bdf075c5c6acba8ae8195c5a87f9990c3c3a`.
Production stayed READY at that SHA:
`dpl_9wzNUPSBVGnnZ39GqXwRNaBzaPCC`.
No production deployment, public endpoint, migration on main or Preview,
provider request, provider contact, fixture MCP change, merge or Part 3B.2 work.

