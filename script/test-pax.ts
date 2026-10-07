// Selvsjekk for passasjer- og overgangslogikken (ingen testrammeverk i repoet).
// Kjør:  npx tsx script/test-pax.ts
import assert from "node:assert/strict";
import { paxDepKey, legLoad, crowdLevel, type PaxLine } from "../client/src/lib/pax";
import { shrunkProb, probFromGaps, POOL_PRIOR_DAYS } from "../client/src/lib/trip-shared";

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

// --- paxDepKey: samme regel som KEY_SQL i pipeline/passenger_stats.py ------
test("paxDepKey: KOL/OST/TRO bruker siste _-ledd", () => {
  assert.equal(paxDepKey("KOL:ServiceJourney:1003_251008123066227_1001"), "1001");
  assert.equal(paxDepKey("TRO:ServiceJourney:20_260212206099211_7038"), "7038");
});
test("paxDepKey: Skyss bruker siste --ledd", () => {
  assert.equal(paxDepKey("SKY:ServiceJourney:16E-198134-19357808"), "19357808");
});
test("paxDepKey: id uten skilletegn er seg selv", () => {
  assert.equal(paxDepKey("AVI:ServiceJourney:DX568"), "DX568");
});

// --- legLoad ---------------------------------------------------------------
const line: PaxLine = {
  lineRef: "KOL:Line:8_1006", op: "KOL", code: "5", name: "Test", mode: "bus", month: "2026-08",
  kpi: {}, history: [], hourly: [],
  stops: [
    ["NSR:Quay:1", "A", 0, 0, 0, 0, false],
    ["NSR:Quay:2", "B", 0, 0, 0, 0, false],
    ["NSR:Quay:3", "C", 0, 0, 0, 0, false],
    ["NSR:Quay:4", "D", 0, 0, 0, 0, false],
  ],
  deps: [
    { k: "1001", hs: "D", dt: "weekday", t: "07:00", runs: 20, s: [0, 1, 2, 3], o: [0, 5, 10, 15],
      l: [10, 40, 25, 0], b: [10, 30, 0, 0], a: [0, 0, 15, 25], d: [0, 1, 2, 3] },
    { k: "1002", hs: "D", dt: "weekday", t: "07:30", runs: 20, s: [0, 1, 2, 3], o: [0, 5, 10, 15],
      l: [5, 8, 6, 0], b: [5, 3, 0, 0], a: [0, 0, 2, 6], d: [0, 0, 1, 1] },
    { k: "3001", hs: "D", dt: "sunday", t: "07:00", runs: 4, s: [0, 1, 2, 3], o: [0, 5, 10, 15],
      l: [2, 3, 2, 0], b: [2, 1, 0, 0], a: [0, 0, 1, 2], d: [0, 0, 0, 0] },
  ],
};

test("legLoad: samme avgang (id) gir høyeste belegg mellom på- og avstigning", () => {
  const r = legLoad(line, { sjId: "KOL:ServiceJourney:1006_999_1001", fromQuay: "NSR:Quay:1", toQuay: "NSR:Quay:4", dayType: "weekday" });
  assert.ok(r);
  assert.equal(r!.match, "exact");
  assert.equal(r!.peak, 40); // belegg etter stopp A, B, C — ikke etter D
});
test("legLoad: delstrekning tar bare med stoppene i legget", () => {
  const r = legLoad(line, { sjId: "x_1001", fromQuay: "NSR:Quay:3", toQuay: "NSR:Quay:4", dayType: "weekday" });
  assert.equal(r!.peak, 25);
});
test("legLoad: ukjent id faller tilbake til nærmeste avgang samme dagtype ±6 min", () => {
  const when = new Date(2026, 9, 6, 7, 33); // 07:33 fra stopp A
  const r = legLoad(line, { sjId: "x_9999", fromQuay: "NSR:Quay:1", toQuay: "NSR:Quay:4", aimedStart: when, dayType: "weekday" });
  assert.equal(r!.match, "nearby");
  assert.equal(r!.dep.k, "1002");
});
test("legLoad: ingen treff utenfor ±6 min", () => {
  const when = new Date(2026, 9, 6, 7, 15);
  const r = legLoad(line, { sjId: null, fromQuay: "NSR:Quay:1", toQuay: "NSR:Quay:4", aimedStart: when, dayType: "weekday" });
  assert.equal(r, null);
});
test("legLoad: annen dagtype matches ikke på tid", () => {
  const when = new Date(2026, 9, 6, 7, 0);
  const r = legLoad(line, { fromQuay: "NSR:Quay:1", toQuay: "NSR:Quay:4", aimedStart: when, dayType: "saturday" });
  assert.equal(r, null);
});
test("legLoad: avstigning før påstigning gir null", () => {
  assert.equal(legLoad(line, { sjId: "x_1001", fromQuay: "NSR:Quay:4", toQuay: "NSR:Quay:1" }), null);
});

// --- crowdLevel -----------------------------------------------------------------
test("crowdLevel: terskler", () => {
  assert.equal(crowdLevel(5)!.key, "low");
  assert.equal(crowdLevel(20)!.key, "some");
  assert.equal(crowdLevel(35)!.key, "busy");
  assert.equal(crowdLevel(60)!.key, "full");
  assert.equal(crowdLevel(121)!.key, "multi");
  assert.equal(crowdLevel(null), null);
});

// --- shrunkProb -----------------------------------------------------------------
test("shrunkProb: bare sammenlignbare når egne dager mangler", () => {
  assert.equal(shrunkProb([], [5, 5, 0, 0], 3), 0.5);
});
test("shrunkProb: bare egne når sammenlignbare mangler", () => {
  assert.equal(shrunkProb([5, 0], [], 3), 0.5);
});
test("shrunkProb: veid snitt med POOL_PRIOR_DAYS", () => {
  const own = Array(10).fill(5);          // 100 %
  const pool = [5, 5, 0, 0];              // 50 %
  const expected = (10 * 1 + POOL_PRIOR_DAYS * 0.5) / (10 + POOL_PRIOR_DAYS);
  assert.ok(Math.abs(shrunkProb(own, pool, 3) - expected) < 1e-12);
});
test("shrunkProb: ingen data gir -1", () => {
  assert.equal(shrunkProb([], [], 3), -1);
  assert.equal(probFromGaps([], 3), -1);
});

console.log(`\n${n} tester OK`);
