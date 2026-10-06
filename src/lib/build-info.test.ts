import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILD_INFO, formatBuildTime } from "./build-info.ts";

describe("build identity", () => {
  it("exposes a short commit and a valid deployment time", () => {
    assert.match(BUILD_INFO.commit, /^(?:[0-9a-f]{7}|local)$/);
    assert.ok(Number.isFinite(Date.parse(BUILD_INFO.deployedAt)));
    assert.notEqual(formatBuildTime(BUILD_INFO.deployedAt), "time unavailable");
  });

  it("fails quietly for an invalid deployment time", () => {
    assert.equal(formatBuildTime("not-a-time"), "time unavailable");
  });
});
