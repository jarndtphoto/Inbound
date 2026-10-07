import test from "node:test";
import assert from "node:assert/strict";
import { reuseAdsbRequest, withAdsbRequestScope } from "./adsb-request-scope.server.ts";
import type { AdsbAcquisition } from "./adsb-acquisition.server.ts";

const empty: AdsbAcquisition = { data: { ac: [] }, receivedAt: 1000, status: "ok", cache: false };

test("one story reuses pending and empty results without changing observation time", async () => {
  let calls = 0;
  await withAdsbRequestScope(async () => {
    const acquire = async () => { calls++; return empty; };
    const [first, second] = await Promise.all([reuseAdsbRequest("fi:AA3398", acquire), reuseAdsbRequest("fi:AA3398", acquire)]);
    assert.equal(first, second);
    assert.equal(await reuseAdsbRequest("fi:AA3398", acquire), empty);
    assert.equal(first.receivedAt, 1000);
  });
  assert.equal(calls, 1);
});

test("operating, marketing and different provider endpoints remain distinct", async () => {
  let calls = 0;
  await withAdsbRequestScope(async () => {
    for (const key of ["fi:AAL3398", "fi:AA3398", "fi:ENY3398", "lol:ENY3398"])
      await reuseAdsbRequest(key, async () => { calls++; return empty; });
  });
  assert.equal(calls, 4);
});

test("overlapping stories and later polls never share request-local negative outcomes", async () => {
  let calls = 0;
  const run = () => withAdsbRequestScope(async () => {
    const acquire = async () => { calls++; return { ...empty, status: "busy" as const }; };
    await reuseAdsbRequest("fi:ENY3398", acquire);
    await reuseAdsbRequest("fi:ENY3398", acquire);
  });
  await Promise.all([run(), run()]);
  await run();
  assert.equal(calls, 3);
});

test("unscoped Ground callers continue to acquire independently", async () => {
  let calls = 0;
  const acquire = async () => { calls++; return empty; };
  await reuseAdsbRequest("fi:ENY3398", acquire);
  await reuseAdsbRequest("fi:ENY3398", acquire);
  assert.equal(calls, 2);
});

test("failed work is reused only within its own build", async () => {
  let calls = 0;
  const acquire = async (): Promise<AdsbAcquisition> => { calls++; throw new Error("fixture failure"); };
  await withAdsbRequestScope(async () => {
    await assert.rejects(reuseAdsbRequest("fi:ENY3398", acquire), /fixture failure/);
    await assert.rejects(reuseAdsbRequest("fi:ENY3398", acquire), /fixture failure/);
  });
  await withAdsbRequestScope(async () => {
    await assert.rejects(reuseAdsbRequest("fi:ENY3398", acquire), /fixture failure/);
  });
  assert.equal(calls, 2);
});
