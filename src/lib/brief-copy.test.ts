import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeBrief, diffBriefLog, logManualRefresh, type RideFacts } from "./brief-copy.ts";

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
  it("seeds a filed line and keeps it passenger-plain", () => {
    const b = composeBrief(facts());
    assert.equal(b.log.length, 1);
    assert.equal(b.log[0].kind, "update");
    assert.match(b.log[0].text, /filed briefing/i);
    assert.equal(JARGON.test(b.log.map((e) => e.text).join(" ")), false);
  });

  it("logs taxi, takeoff, and landing in everyday words", () => {
    let b = composeBrief(facts({ now: "push" }));
    b = composeBrief(facts({ now: "taxi" }), b);
    b = composeBrief(facts({ now: "ride" }), b);
    b = composeBrief(facts({ now: "arrival" }), b);
    b = composeBrief(facts({ now: "gate" }), b);
    const texts = b.log.map((e) => e.text).join(" | ");
    assert.match(texts, /On the move/);
    assert.match(texts, /Taking off/);
    assert.match(texts, /Landing/);
    assert.match(texts, /Arriving at the gate/);
    assert.equal(JARGON.test(texts), false);
  });

  it("logs a delay and a 12-minute later arrival", () => {
    let b = composeBrief(facts({ delayMin: 0, landUnix: 1_200_000 }));
    b = composeBrief(facts({ delayMin: 25, landUnix: 1_200_000 + 12 * 60 }), b);
    const delay = b.log.find((e) => e.kind === "delay");
    const sched = b.log.find((e) => e.kind === "schedule");
    assert.ok(delay);
    assert.match(delay.text, /25 minutes/);
    assert.ok(sched);
    assert.match(sched.text, /12 minutes later/);
  });

  it("ignores tiny schedule jitter", () => {
    let b = composeBrief(facts({ landUnix: 1_200_000, land: "11:04 AM" }));
    const next = composeBrief(facts({ landUnix: 1_200_000 + 90, land: "11:05 AM" }), b);
    assert.equal(next, b);
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

  it("logs a manual refresh without jargon", () => {
    const b = composeBrief(facts({ now: "ride" }));
    const next = logManualRefresh(b);
    assert.ok(next);
    assert.match(next.log[next.log.length - 1].text, /Manual refresh/);
    assert.equal(JARGON.test(next.log.map((e) => e.text).join(" ")), false);
    const again = logManualRefresh(next);
    assert.ok(again);
    const manuals = again.log.filter((e) => e.text === "Manual refresh");
    assert.ok(manuals.length <= 1);
  });

  it("caps the log", () => {
    let b = composeBrief(facts({ delayMin: 0 }));
    for (let i = 1; i <= 90; i++) {
      b = composeBrief(facts({ delayMin: 10 + i * 5, wxHash: `h${i}` }), b);
    }
    assert.ok(b.log.length <= 80);
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
    const brief = composeBrief(facts({now:"taxi",stage:"taxi",pushKind:"actual",delayMin:82,push:"9:42 PM CDT",takeoff:"10:33 PM CDT"}));
    assert.match(brief.lead, /on the move/i);
    assert.match(brief.lead, /Gate departure reported at 9:42 PM CDT/);
    assert.doesNotMatch(brief.lead, /Inbound|Push is/);
    assert.match(brief.lead, /Estimated takeoff around 10:33 PM CDT/);
  });
});

it("does not call an estimated movement time a reported departure", () => {
 const b = composeBrief(facts({now:"taxi",pushKind:"estimated"}));
 assert.match(b.lead, /first observed around/);
 assert.doesNotMatch(b.lead, /Gate departure reported/);
});
