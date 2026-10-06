export type BuildInfo = {
  commit: string;
  deployedAt: string;
};

declare const __INBOUND_BUILD_COMMIT__: string;
declare const __INBOUND_BUILD_TIME__: string;

const runtimeEnv = typeof process !== "undefined" ? process.env : undefined;
const runtimeCommit = runtimeEnv?.VERCEL_GIT_COMMIT_SHA ?? runtimeEnv?.GIT_COMMIT_SHA ?? "local";
const runtimeTime = runtimeEnv?.VERCEL_DEPLOYMENT_CREATED_AT ?? new Date().toISOString();

export const BUILD_INFO: BuildInfo = Object.freeze({
  commit: (typeof __INBOUND_BUILD_COMMIT__ !== "undefined" ? __INBOUND_BUILD_COMMIT__ : runtimeCommit).slice(0, 7),
  deployedAt: typeof __INBOUND_BUILD_TIME__ !== "undefined" ? __INBOUND_BUILD_TIME__ : runtimeTime,
});

export function formatBuildTime(value: string): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(time);
}
