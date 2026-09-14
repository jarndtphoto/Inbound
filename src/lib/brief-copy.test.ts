import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { briefLogLabel, briefLogText, composeBrief, diffBriefLog, logManualRefresh, type RideFacts } from "./brief-copy.ts";

function facts(over: Partial<RideFacts> = {}): RideFacts {
  return {
    q: "UA 1",
    iata: "UA1",
    airline: "United",
    fromCity: "Honolulu",
    fromIata: "HNL",
    toCity: "Chicago",
    toIata: "ORD",
    stage: "push",
    now: "push",
    live: true,
    typeName: "Boeing 777",
    registration: "N204UA",
    grade: "B",
    label: "On time",
    summary: "",
    reasons: [],
    remainingNm: 3700,
    etaMin: 420,
    originWx: "VFR. Trade winds.",
    originNas: "n/a",
    destWx: "VFR",
    destNas: "n/a",
    inbound: "At the gate",
    inboundHeadline: "At the gate",
    inboundDetail: "",
    inboundStatus: "complete",
    rideLabel: "Smooth",
    push: "7:52 PM",
    taxiOutMin: 18,
    taxiOutKind: "typical",
    takeoff: "8:10 PM",
    land: "11:04 AM",
    taxiInMin: 12,
    taxiInKind: "typical",
    originGate: "G9",
    destGate: "C18",
    delayMin: 0,
    worstChop: "smooth",
    convective: false,
    destCat: "VFR",
    originCat: "VFR",
    wxHash: "aaa",
    pushUnix: 1_000_000,
    takeoffUnix: 1_001_000,
    landUnix: 1_200_000,
    ...over,
  };
}

const JARGON = /\b(SIGMET|AIRMET|PIREP|METAR|TAF|NAS|OOOI|FL\d{2,3}|IFR|LIFR|MVFR|VFR)\b/;

describe("briefing update log", () => {
  it("does not seed the passenger timeline with audit-only entries", () => {
    const b = composeBrief(facts());
    assert.equal(b.log.length, 0);
    assert.equal(JARGON.test(b.log.map((e) => e.text).join(" ")), false);
  });

  it("logs taxi, takeoff, and landing in everyday words", () => {
    let b = composeBrief(facts({ now: "push" }));
    b = composeBrief(facts({ now: "taxi" }), b);
    b = composeBrief(facts({ now: "ride" }), b);
    b = composeBrief(facts({ now: "arrival" }), b);
    b = composeBrief(facts({ now: "gate" }), b);
    const texts = b.log.map((e) => e.text).join(" | ");
    assert.match(texts, /Taxiing out/);
    assert.match(texts, /In flight/);
    assert.match(texts, /Arrival/);
    assert.match(texts, /At the gate/);
    assert.equal(JARGON.test(texts), false);
  });

  it("logs a delay but ignores a routine 12-minute arrival adjustment", () => {
    let b = composeBrief(facts({ delayMin: 0, landUnix: 1_200_000 }));
    b = composeBrief(facts({ delayMin: 25, landUnix: 1_200_000 + 12 * 60 }), b);
    const delay = b.log.find((e) => e.kind === "delay");
    assert.ok(delay);
    assert.match(delay.text, /25 minutes/);
    assert.equal(b.log.some((e) => /Arrival now looks/i.test(e.text)), false);
  });

  it("ignores tiny schedule jitter", () => {
    let b = composeBrief(facts({ landUnix: 1_200_000, land: "11:04 AM" }));
    const next = composeBrief(facts({ landUnix: 1_200_000 + 90, land: "11:05 AM" }), b);
    assert.deepEqual(next.log, b.log);
  });

  it("logs material turbulence and thunderstorms without aviation codes", () => {
    let b = composeBrief(facts({ worstChop: "smooth", convective: false, wxHash: "a" }));
    b = composeBrief(
      facts({
        worstChop: "moderate",
        rideLabel: "Moderate turbulence",
        convective: true,
        wxHash: "b",
        wxDeltas: ["a new chop PIREP showed up", "thunderstorm SIGMET"],
      }),
      b,
    );
    const wx = b.log.filter((e) => e.kind === "weather").map((e) => e.text);
    assert.ok(wx.some((t) => /moderate turbulence/i.test(t)));
    assert.ok(wx.some((t) => /thunderstorms along the route/i.test(t)));
    assert.equal(wx.some((t) => /bump/i.test(t)), false);
    assert.equal(wx.some((t) => JARGON.test(t)), false);
  });

  it("ignores light-smooth chop chatter and dest-category flips", () => {
    let b = composeBrief(facts({ worstChop: "smooth", destCat: "VFR", wxHash: "a" }));
    const light = composeBrief(facts({ worstChop: "light", rideLabel: "Light turbulence", destCat: "MVFR", wxHash: "b" }), b);
    assert.equal(light.log.filter((e) => e.kind === "weather").length, 0);
    b = composeBrief(
      facts({ worstChop: "moderate", rideLabel: "Moderate turbulence", destCat: "IFR", wxHash: "c" }),
      light,
    );
    const wx = b.log.filter((e) => e.kind === "weather").map((e) => e.text);
    assert.ok(wx.some((t) => /moderate turbulence/i.test(t)));
    assert.equal(wx.some((t) => /arrival looks/i.test(t)), false);
    assert.equal(wx.some((t) => /bump/i.test(t)), false);
  });

  it("uses was → now when turbulence eases", () => {
    let b = composeBrief(facts({ worstChop: "moderate", rideLabel: "Moderate turbulence", wxHash: "a" }));
    b = composeBrief(facts({ worstChop: "light", rideLabel: "Light turbulence", wxHash: "b" }), b);
    const wx = b.log.filter((e) => e.kind === "weather").map((e) => e.text);
    assert.ok(wx.some((t) => /was moderate turbulence → now light turbulence/i.test(t)));
  });

  it("ride briefing uses miles and does not mix airborne with no-signal", () => {
    const live = composeBrief(facts({ now: "ride", live: true, remainingNm: 3070 }));
    assert.match(live.lead, /3,533 miles/);
    assert.match(live.lead, /in the air/i);
    assert.equal(/not broadcasting|no ads-b|you're airborne/i.test(live.lead), false);
    const dark = composeBrief(facts({ now: "ride", live: false, remainingNm: 3070 }));
    assert.match(dark.lead, /3,533 miles/);
    assert.match(dark.lead, /live position unavailable/i);
    assert.equal(/you're airborne/i.test(dark.lead), false);
  });

  it("separates landed from at-the-gate in the arrival brief", () => {
    const b = composeBrief(
      facts({
        now: "arrival",
        land: "4:51 PM",
        landKind: "actual",
        gate: "5:00 PM",
        gateKind: "estimated",
      }),
    );
    assert.match(b.lead, /landed at 4:51 pm/i);
    assert.match(b.lead, /taxiing in/i);
    assert.match(b.lead, /at the gate around 5:00 pm/i);
    assert.equal(/you're at the gate/i.test(b.lead), false);
  });

  it("does not repeat the same line", () => {
    let b = composeBrief(facts({ now: "push" }));
    b = composeBrief(facts({ now: "taxi" }), b);
    const n = b.log.length;
    b = composeBrief(facts({ now: "taxi" }), b);
    assert.equal(b.log.length, n);
  });

  it("does not add manual refreshes to the passenger timeline", () => {
    const b = composeBrief(facts({ now: "ride" }));
    const next = logManualRefresh(b);
    assert.ok(next);
    assert.deepEqual(next.log, b.log);
    assert.ok((next.liveAt ?? 0) >= (b.liveAt ?? 0));
  });

  it("caps the log", () => {
    let b = composeBrief(facts({ delayMin: 0 }));
    for (let i = 1; i <= 90; i++) {
      b = composeBrief(facts({ delayMin: 10 + i * 5, wxHash: `h${i}` }), b);
    }
    assert.ok(b.log.length <= 24);
  });

  it("maps airport delay programs into plain words", () => {
    const lines = diffBriefLog(
      {
        stage: "push",
        delay: 0,
        arriveDelay: null,
        taxiOut: 18,
        taxiOutKind: "typical",
        taxiIn: 12,
        taxiInKind: "typical",
        ride: "Smooth",
        destNas: "",
        originNas: "",
        inbound: "complete",
        land: "11:04 AM",
        takeoff: "8:10 PM",
        push: "7:52 PM",
        destGate: "C18",
        wx: "a",
        worstChop: "smooth",
        convective: false,
        destCat: "VFR",
        originCat: "VFR",
        pushUnix: 1,
        takeoffUnix: 2,
        landUnix: 3,
      },
      {
        stage: "push",
        delay: 0,
        arriveDelay: null,
        taxiOut: 18,
        taxiOutKind: "typical",
        taxiIn: 12,
        taxiInKind: "typical",
        ride: "Smooth",
        destNas: "GDP / Thunderstorms",
        originNas: "",
        inbound: "complete",
        land: "11:04 AM",
        takeoff: "8:10 PM",
        push: "7:52 PM",
        destGate: "C18",
        wx: "a",
        worstChop: "smooth",
        convective: false,
        destCat: "VFR",
        originCat: "VFR",
        pushUnix: 1,
        takeoffUnix: 2,
        landUnix: 3,
      },
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, "delay");
    assert.match(lines[0].text, /thunderstorms/i);
    assert.equal(JARGON.test(lines[0].text), false);
  });
});


describe("on the move briefing", () => {
  it("describes a recorded departure without obsolete inbound or future push wording", () => {
    const brief = composeBrief(facts({now:"taxi",stage:"taxi",pushKind:"actual",pushSource:"provider_actual",delayMin:82,push:"9:42 PM CDT",takeoff:"10:33 PM CDT"}));
    assert.match(brief.lead, /on the move/i);
    assert.match(brief.lead, /Gate departure reported at 9:42 PM CDT/);
    assert.doesNotMatch(brief.lead, /Inbound|Push is/);
    assert.match(brief.lead, /Estimated takeoff around 10:33 PM CDT/);
  });
});

it("does not call an estimated movement time a reported departure", () => {
 const b = composeBrief(facts({now:"taxi",pushKind:"estimated"}));
 assert.match(b.lead, /Departure time is not yet confirmed/);
 assert.doesNotMatch(b.lead, /Gate departure reported/);
});


it("refreshes current text even for changes below the history thresholds", () => {
 const before = composeBrief(facts({taxiInMin:10}));
 const after = composeBrief(facts({taxiInMin:12}), before);
 assert.match(after.lead, /taxi in 12 minutes/i);
 assert.equal(after.log.length, before.log.length);
 assert.ok((after.liveAt ?? 0) >= (before.liveAt ?? 0));
});

describe("UAL219 curated briefing regression", () => {
  it("supersedes obsolete departure estimates after actual pushback and takeoff", () => {
    const before = composeBrief(facts({
      now: "taxi", stage: "taxi", push: "9:25 AM CDT", pushKind: "estimated",
      pushSource: null, takeoff: "10:34 AM CDT", takeoffKind: "estimated",
    }));
    const legacy = {
      ...before,
      log: [
        { at: 1, kind: "update", text: "Filed briefing is up" },
        { at: 2, kind: "delay", text: "Delay at the airport — about 38 minutes" },
        { at: 3, kind: "schedule", text: "Departure time moved to 10:03 AM CDT" },
        { at: 4, kind: "schedule", text: "Departure time moved to 9:25 AM CDT" },
        { at: 5, kind: "schedule", text: "Takeoff now looks like 10:34 AM CDT" },
        { at: 6, kind: "schedule", text: "Estimated taxi out is now 69 minutes" },
        { at: 7, kind: "stage", text: "On the move — pushback and taxi" },
      ],
    } as typeof before;
    const after = composeBrief(facts({
      now: "ride", stage: "ride", push: "9:46 AM CDT", pushKind: "actual",
      pushSource: "track_detected", pushUnix: 1_000_000,
      takeoff: "10:50 AM CDT", takeoffKind: "actual", takeoffUnix: 1_003_840,
    }), legacy);
    const text = after.log.map((entry) => entry.text).join(" | ");
    assert.match(text, /Pushed back from HNL at 9:46 AM CDT/);
    assert.match(text, /Taxiing out/);
    assert.match(text, /Took off from HNL at 10:50 AM CDT/);
    assert.doesNotMatch(text, /9:25|10:03|Takeoff now looks|Estimated taxi out|Delay at the airport|Filed briefing/);
  });

  it("does not persist minor arrival or taxi estimate fluctuations", () => {
    let brief = composeBrief(facts({ now: "ride", stage: "ride", landUnix: 1_200_000, taxiInMin: 10 }));
    brief = composeBrief(facts({ now: "ride", stage: "ride", landUnix: 1_200_000 + 8 * 60, taxiInMin: 13 }), brief);
    const text = brief.log.map((entry) => entry.text).join(" | ");
    assert.doesNotMatch(text, /Arrival now looks|Estimated taxi in/);
  });

  it("collapses opposite arrival estimates and removes them after landing", () => {
    let brief = composeBrief(facts({ now: "ride", stage: "ride", landUnix: 1_200_000 }));
    brief = composeBrief(facts({ now: "ride", stage: "ride", landUnix: 1_200_000 + 30 * 60 }), brief);
    brief = composeBrief(facts({ now: "ride", stage: "ride", landUnix: 1_200_000, land: "11:04 AM" }), brief);
    assert.equal(brief.log.some((entry) => /Arrival now looks/.test(entry.text)), false);
    brief = composeBrief(facts({ now: "taxi_in", stage: "taxi_in", landKind: "actual", land: "11:04 AM" }), brief);
    assert.equal(brief.log.some((entry) => /Arrival now looks|Estimated taxi in/.test(entry.text)), false);
    assert.match(brief.log.map((entry) => entry.text).join(" | "), /Landed at 11:04 AM|Taxiing in/);
  });
});

describe("Overview record migration", () => {
  it("keeps completed trip events in the Briefing chronology with passenger labels", () => {
    let brief = composeBrief(facts({
      now: "push", stage: "push", fromIata: "ORD", toIata: "HNL",
      push: "9:37 AM CDT", pushKind: "actual", pushSource: "track_detected", pushUnix: 1_000_000,
    }));
    brief = composeBrief(facts({ now: "taxi", stage: "taxi", fromIata: "ORD", toIata: "HNL",
      push: "9:37 AM CDT", pushKind: "actual", pushSource: "track_detected", pushUnix: 1_000_000 }), brief);
    brief = composeBrief(facts({ now: "ride", stage: "ride", fromIata: "ORD", toIata: "HNL",
      push: "9:37 AM CDT", pushKind: "actual", pushSource: "track_detected", pushUnix: 1_000_000,
      takeoff: "10:08 AM CDT", takeoffKind: "actual", takeoffUnix: 1_001_860 }), brief);
    brief = composeBrief(facts({ now: "final_approach", stage: "final_approach", fromIata: "ORD", toIata: "HNL",
      push: "9:37 AM CDT", pushKind: "actual", pushSource: "track_detected", pushUnix: 1_000_000,
      takeoff: "10:08 AM CDT", takeoffKind: "actual", takeoffUnix: 1_001_860 }), brief);
    brief = composeBrief(facts({ now: "taxi_in", stage: "taxi_in", fromIata: "ORD", toIata: "HNL",
      push: "9:37 AM CDT", pushKind: "actual", pushSource: "track_detected", pushUnix: 1_000_000,
      takeoff: "10:08 AM CDT", takeoffKind: "actual", takeoffUnix: 1_001_860,
      land: "2:14 PM HST", landKind: "actual", landUnix: 1_025_000 }), brief);
    brief = composeBrief(facts({ now: "gate", stage: "gate", fromIata: "ORD", toIata: "HNL",
      push: "9:37 AM CDT", pushKind: "actual", pushSource: "track_detected", pushUnix: 1_000_000,
      takeoff: "10:08 AM CDT", takeoffKind: "actual", takeoffUnix: 1_001_860,
      land: "2:14 PM HST", landKind: "actual", landUnix: 1_025_000,
      gate: "2:26 PM HST", gateKind: "actual", destGate: "G4" }), brief);
    const labels = brief.log.map(briefLogLabel);
    const text = brief.log.map((entry) => entry.text).join(" | ");
    for (const label of ["Pushback", "Taxiing out", "Takeoff", "Final approach", "Landed", "Taxiing in", "At the gate"]) {
      assert.equal(labels.filter((candidate) => candidate === label).length, 1, `${label} appears once`);
    }
    assert.match(text, /Pushed back from ORD at 9:37 AM CDT/);
    assert.match(text, /Took off from ORD at 10:08 AM CDT/);
    assert.match(text, /Landed at HNL at 2:14 PM HST/);
    assert.match(text, /Arrived at Gate G4 at 2:26 PM HST/);
  });

  it("logs meaningful gate changes and removes the standalone Overview Records card", () => {
    const before = composeBrief(facts({ now: "origin_gate", originGate: "B16", destGate: "G2" }));
    const after = composeBrief(facts({ now: "origin_gate", originGate: "B18", destGate: "G4" }), before);
    const text = after.log.map((entry) => entry.text).join(" | ");
    assert.match(text, /Departure gate changed to B18/);
    assert.match(text, /Arrival gate changed to G4/);
    const source = readFileSync(new URL("../components/filed-app.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(source, /function RecordCard|function recordRows|<RecordCard/);
  });

  it("keeps live priorities visible and puts only secondary facts in informative disclosures", () => {
    const source = readFileSync(new URL("../components/filed-app.tsx", import.meta.url), "utf8");
    const overview = source.slice(source.indexOf('id="panel-Overview"'), source.indexOf('id="panel-Route"'));
    assert.ok(overview.indexOf("<FlightHead") < overview.indexOf("<OverviewDetails"));
    assert.ok(overview.indexOf("<TravelerCompanion") < overview.indexOf("<OverviewDetails"));
    for (const title of ["Flight details", "Aircraft", "Airport details"]) {
      assert.match(source, new RegExp(`title="${title}"`));
    }
    assert.match(source, /summary={`\$\{story\.iata\} · \$\{story\.origin\.iata\} → \$\{story\.dest\.iata\}`}/);
    assert.match(source, /summary=\{aircraftSummary\}/);
    assert.match(source, /summary={`\$\{originStop\} → \$\{destStop\}`}/);
    const details = source.slice(source.indexOf("function OverviewDetails"), source.indexOf("function kindLabel"));
    assert.doesNotMatch(details, /callsign|chosenPosition|seenSec|hex/i);
  });
});


describe("UA2762 approach status fluctuations", () => {
 it("does not record another takeoff when approach is reassessed as flight", () => {
  const first = composeBrief(facts({now:"arrival",stage:"arrival"}));
  const next = composeBrief(facts({now:"ride",stage:"ride"}), first);
  assert.equal(next.log.filter(e => e.kind === "stage").length, 0);
  assert.doesNotMatch(next.lead, /taking off/i);
 });
 it("labels legacy stage entries without claiming physical takeoff or touchdown", () => {
  assert.equal(briefLogText({at:1,kind:"stage",text:"Taking off"}), "In-flight status update");
  assert.equal(briefLogText({at:1,kind:"stage",text:"Landing"}), "Arrival status update");
 });
});
