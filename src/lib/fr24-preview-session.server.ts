import type { Sql } from "./db.ts";

const MAX_INT = 2_147_483_647;
const LIVE_POSITION_MAXIMUM = 8;

export type Fr24PreviewBlockReason =
  | "not_preview" | "disabled" | "invalid_config" | "config_mismatch"
  | "expired" | "budget_exhausted" | "attempt_limit" | "stopped_402"
  | "in_flight" | "database_unavailable";

export type Fr24PreviewConfig = {
  sessionId: string;
  creditCap: number;
  attemptCap: number;
  expiresAt: number;
};

export type Fr24PreviewSessionStatus = {
  mode: "fr24-only";
  modeEnabled: boolean;
  enabled: boolean;
  state: "ready" | Fr24PreviewBlockReason;
  reason: Fr24PreviewBlockReason | null;
  blocked: boolean;
  sessionId: string | null;
  creditCap: number;
  attemptCap: number;
  expiresAt: number | null;
  /** Pessimistic total, including unfinished and failed attempts. Never refunded. */
  creditsConsumed: number;
  creditsReserved: number;
  attempts: number;
  remainingCredits: number;
  remainingAttempts: number;
  stopped402: boolean;
  inFlight: boolean;
  lastStatusCode: number | null;
  lastErrorKind: string | null;
};

export type Fr24PreviewReservation = {
  reservationId: string;
  sessionId: string;
  maximum: number;
  expiresAt: number;
};

type SessionRow = {
  session_id: string;
  credit_cap: number;
  attempt_cap: number;
  expires_at: number;
  credits_consumed: number;
  attempts: number;
  stopped_402: boolean;
  active_reservation_id: string | null;
  last_status_code: number | null;
  last_error_kind: string | null;
  guard_now: number;
};

/** Server-only mode selection is independent of permission to spend. */
export function fr24PreviewModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV === "preview" && env.FR24_PREVIEW_MODE === "fr24-only";
}

function positiveInt(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= MAX_INT ? number : null;
}

/** No inferred allowance, default enabled flag, rolling expiry, or credit reset. */
export function readFr24PreviewConfig(env: NodeJS.ProcessEnv = process.env):
  { ok: true; config: Fr24PreviewConfig } | { ok: false; reason: Fr24PreviewBlockReason } {
  if (!fr24PreviewModeEnabled(env)) return { ok: false, reason: "not_preview" };
  if (env.FR24_PREVIEW_ENABLED !== "1") return { ok: false, reason: "disabled" };
  const sessionId = env.FR24_PREVIEW_SESSION_ID ?? "";
  const creditCap = positiveInt(env.FR24_PREVIEW_CREDIT_CAP);
  const expiry = env.FR24_PREVIEW_EXPIRES_AT ?? "";
  const expiresAt = Date.parse(expiry);
  // Only unambiguous absolute UTC timestamps; Date.parse alone accepts relative
  // dates and silently normalizes invalid calendar dates.
  const absoluteExpiry = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry)
    && Number.isSafeInteger(expiresAt) && expiresAt > 0
    && new Date(expiresAt).toISOString() === (expiry.includes(".") ? expiry : expiry.replace("Z", ".000Z"));
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)
    || creditCap === null || creditCap < LIVE_POSITION_MAXIMUM || !absoluteExpiry) {
    return { ok: false, reason: "invalid_config" };
  }
  const derivedAttempts = Math.floor(creditCap / LIVE_POSITION_MAXIMUM);
  const attemptCap = env.FR24_PREVIEW_ATTEMPT_CAP === undefined
    ? derivedAttempts : positiveInt(env.FR24_PREVIEW_ATTEMPT_CAP);
  if (attemptCap === null || attemptCap > derivedAttempts) return { ok: false, reason: "invalid_config" };
  return { ok: true, config: { sessionId, creditCap, attemptCap, expiresAt } };
}

const safeErrorKinds = new Set(["402", "429", "http", "timeout", "parse", "cache", "network", "error", "none", "dailybudget", "daily_budget"]);
function safeErrorKind(value: string | null | undefined): string | null {
  return value == null ? null : safeErrorKinds.has(value) ? value : "error";
}

function snapshot(env: NodeJS.ProcessEnv, config: Fr24PreviewConfig | null,
  reason: Fr24PreviewBlockReason | null, row?: SessionRow): Fr24PreviewSessionStatus {
  const creditCap = row?.credit_cap ?? config?.creditCap ?? 0;
  const attemptCap = row?.attempt_cap ?? config?.attemptCap ?? 0;
  const creditsConsumed = row?.credits_consumed ?? 0;
  const attempts = row?.attempts ?? 0;
  return {
    mode: "fr24-only", modeEnabled: fr24PreviewModeEnabled(env),
    enabled: fr24PreviewModeEnabled(env) && env.FR24_PREVIEW_ENABLED === "1",
    state: reason ?? "ready", reason, blocked: reason !== null,
    sessionId: row?.session_id ?? config?.sessionId ?? null,
    creditCap, attemptCap, expiresAt: row?.expires_at ?? config?.expiresAt ?? null,
    creditsConsumed, creditsReserved: creditsConsumed, attempts,
    remainingCredits: Math.max(0, creditCap - creditsConsumed),
    remainingAttempts: Math.max(0, attemptCap - attempts),
    stopped402: row?.stopped_402 ?? false, inFlight: row?.active_reservation_id != null,
    lastStatusCode: row?.last_status_code ?? null, lastErrorKind: safeErrorKind(row?.last_error_kind),
  };
}

function rowBlockReason(row: SessionRow, config: Fr24PreviewConfig): Fr24PreviewBlockReason | null {
  if (row.credit_cap !== config.creditCap || row.attempt_cap !== config.attemptCap
    || row.expires_at !== config.expiresAt) return "config_mismatch";
  if (row.stopped_402) return "stopped_402";
  if (row.guard_now >= row.expires_at) return "expired";
  if (row.credits_consumed >= row.credit_cap) return "budget_exhausted";
  if (row.attempts >= row.attempt_cap) return "attempt_limit";
  if (row.active_reservation_id !== null) return "in_flight";
  return null;
}

const defaultSqlProvider = async (): Promise<Sql> => {
  // The ordinary DB helper has an in-process PGlite fallback. It is not a
  // cross-instance spend guard and must never authorize a deployed paid call.
  if (!process.env.DATABASE_URL?.trim()) throw new Error("Durable Preview database required");
  const database = await import("./db.ts");
  if (database.dbSource !== "neon") throw new Error("Durable Preview database required");
  return database.getSql();
};

export function createFr24PreviewSessionGuard(
  sqlProvider: () => Promise<Sql> = defaultSqlProvider,
  envProvider: () => NodeJS.ProcessEnv = () => process.env,
) {
  async function status(now = Date.now()): Promise<Fr24PreviewSessionStatus> {
    const env = envProvider(), parsed = readFr24PreviewConfig(env);
    if (!parsed.ok) return snapshot(env, null, parsed.reason);
    const { config } = parsed;
    if (!Number.isSafeInteger(now) || now < 0) return snapshot(env, config, "invalid_config");
    try {
      const sql = await sqlProvider();
      // The first observation freezes the approved parameters. The no-op
      // conflict update returns a concurrent creator's row in the same query.
      const rows = await sql<SessionRow>`
        insert into fr24_preview_sessions (session_id, credit_cap, attempt_cap, expires_at)
        values (${config.sessionId}, ${config.creditCap}, ${config.attemptCap}, ${config.expiresAt})
        on conflict (session_id) do update set session_id = fr24_preview_sessions.session_id
        returning *, greatest(${now}::bigint, floor(extract(epoch from clock_timestamp()) * 1000)::bigint) as guard_now`;
      const row = rows[0];
      return row ? snapshot(env, config, rowBlockReason(row, config), row)
        : snapshot(env, config, "database_unavailable");
    } catch {
      return snapshot(env, config, "database_unavailable");
    }
  }

  async function reserve(maximum: number, now = Date.now()): Promise<Fr24PreviewReservation | null> {
    const parsed = readFr24PreviewConfig(envProvider());
    if (!parsed.ok || !Number.isSafeInteger(maximum) || maximum <= 0 || maximum > MAX_INT
      || !Number.isSafeInteger(now) || now < 0) return null;
    const { config } = parsed;
    if (maximum > config.creditCap || now >= config.expiresAt) return null;
    const reservationId = crypto.randomUUID();
    try {
      const sql = await sqlProvider();
      // The conditional upsert takes the row lock across cold instances. The
      // counters and durable receipt commit in one statement, before dispatch.
      const rows = await sql<{ reservation_id: string }>`
        with guard_clock as (
          select greatest(${now}::bigint, floor(extract(epoch from clock_timestamp()) * 1000)::bigint) as at
        ), admitted as (
          insert into fr24_preview_sessions
            (session_id, credit_cap, attempt_cap, expires_at, credits_consumed, attempts, active_reservation_id)
          select ${config.sessionId}, ${config.creditCap}, ${config.attemptCap}, ${config.expiresAt},
            ${maximum}, 1, ${reservationId}
          from guard_clock where at < ${config.expiresAt}
          on conflict (session_id) do update set
            credits_consumed = fr24_preview_sessions.credits_consumed + ${maximum},
            attempts = fr24_preview_sessions.attempts + 1,
            active_reservation_id = ${reservationId}, updated_at = now()
          where fr24_preview_sessions.credit_cap = excluded.credit_cap
            and fr24_preview_sessions.attempt_cap = excluded.attempt_cap
            and fr24_preview_sessions.expires_at = excluded.expires_at
            and not fr24_preview_sessions.stopped_402
            and fr24_preview_sessions.active_reservation_id is null
            and fr24_preview_sessions.expires_at > (select at from guard_clock)
            and fr24_preview_sessions.credits_consumed <= fr24_preview_sessions.credit_cap - ${maximum}
            and fr24_preview_sessions.attempts < fr24_preview_sessions.attempt_cap
          returning session_id
        )
        insert into fr24_preview_reservations (reservation_id, session_id, maximum_credits, reserved_at)
        select ${reservationId}, session_id, ${maximum}, (select at from guard_clock) from admitted
        returning reservation_id`;
      return rows[0]?.reservation_id === reservationId
        ? { reservationId, sessionId: config.sessionId, maximum, expiresAt: config.expiresAt } : null;
    } catch {
      // Missing migrations, SQL errors and a lost acknowledgement never grant
      // permission to call FR24. A committed uncertain reservation stays spent.
      return null;
    }
  }

  /** One-shot dispatch grant, checked again after any other asynchronous work. */
  async function canDispatch(reservation: Fr24PreviewReservation, now = Date.now()): Promise<boolean> {
    const parsed = readFr24PreviewConfig(envProvider());
    if (!parsed.ok || !Number.isSafeInteger(now) || now < 0) return false;
    const { config } = parsed;
    if (config.sessionId !== reservation.sessionId || config.expiresAt !== reservation.expiresAt
      || now >= config.expiresAt) return false;
    try {
      const sql = await sqlProvider();
      const rows = await sql<{ reservation_id: string }>`
        update fr24_preview_reservations as receipt set
          dispatched_at = greatest(${now}::bigint, floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
        from fr24_preview_sessions as session
        where receipt.reservation_id = ${reservation.reservationId}
          and receipt.session_id = ${reservation.sessionId} and receipt.maximum_credits = ${reservation.maximum}
          and receipt.finished_at is null and receipt.dispatched_at is null
          and session.session_id = receipt.session_id
          and session.active_reservation_id = receipt.reservation_id and not session.stopped_402
          and session.credit_cap = ${config.creditCap} and session.attempt_cap = ${config.attemptCap}
          and session.expires_at = ${config.expiresAt}
          and session.expires_at > greatest(${now}::bigint, floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
        returning receipt.reservation_id`;
      // The response itself might have been delayed beyond the absolute expiry.
      return rows[0]?.reservation_id === reservation.reservationId && Date.now() < config.expiresAt;
    } catch {
      // Keep the active receipt locked: an uncertain grant cannot be retried.
      return false;
    }
  }

  async function finish(reservation: Fr24PreviewReservation, details: {
    statusCode: number | null; errorKind?: string | null;
  }, now = Date.now()): Promise<void> {
    const sql = await sqlProvider();
    const statusCode = Number.isInteger(details.statusCode) && details.statusCode! >= 100 && details.statusCode! <= 599
      ? details.statusCode : null;
    const errorKind = statusCode === 402 ? "402" : safeErrorKind(details.errorKind);
    // Do not re-read config: disabling/redeploying during a request must not
    // prevent its 402 from permanently stopping the ORIGINAL session.
    await sql.query(`
      with finished as (
        update fr24_preview_reservations set
          finished_at = greatest($1::bigint, floor(extract(epoch from clock_timestamp()) * 1000)::bigint),
          status_code = $2, error_kind = $3
        where reservation_id = $4 and session_id = $5 and maximum_credits = $6 and finished_at is null
        returning session_id, reservation_id, finished_at
      )
      update fr24_preview_sessions as session set
        stopped_402 = session.stopped_402 or coalesce($2::integer = 402, false),
        active_reservation_id = case when session.active_reservation_id = finished.reservation_id
          then null else session.active_reservation_id end,
        last_status_code = $2, last_error_kind = $3,
        last_finished_at = finished.finished_at, updated_at = now()
      from finished where session.session_id = finished.session_id
    `, [Number.isSafeInteger(now) && now >= 0 ? now : Date.now(), statusCode, errorKind,
      reservation.reservationId, reservation.sessionId, reservation.maximum]);
  }

  return { status, reserve, canDispatch, finish };
}

type Fr24PreviewGuard = ReturnType<typeof createFr24PreviewSessionGuard>;
let guard: Fr24PreviewGuard = createFr24PreviewSessionGuard();

export function setFr24PreviewSessionGuardForTests(next: Fr24PreviewGuard) { guard = next; }
export const fr24PreviewSessionStatus: Fr24PreviewGuard["status"] = (...args) => guard.status(...args);
export const reserveFr24PreviewSession: Fr24PreviewGuard["reserve"] = (...args) => guard.reserve(...args);
export const canDispatchFr24PreviewSession: Fr24PreviewGuard["canDispatch"] = (...args) => guard.canDispatch(...args);
export const finishFr24PreviewSessionCall: Fr24PreviewGuard["finish"] = (...args) => guard.finish(...args);
