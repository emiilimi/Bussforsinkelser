// Selvsjekk for sanntid i reisemodellen (lib/live-model.ts).
// Kjør:  npx tsx script/test-live.ts
import assert from "node:assert/strict";
import {
  isLive, liveDelayMin, anchoredGrid, anchoredMinutes, prognosisErrorGrid, PROGNOSIS_ERROR,
  boardingBufferMin, earlyQuantile, EARLY_LEVEL,
} from "../client/src/lib/live-model";
import { quantileGrid, transferProbFromMarginals, gridCdf } from "../client/src/lib/trip-model";
import type { TripLeg } from "../client/src/lib/trip-shared";

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok  ${name}`);
}

const NOW = new Date("2026-11-25T12:00:00+01:00").getTime();
const at = (min: number) => new Date(NOW + min * 60000).toISOString();

function leg(o: Partial<TripLeg> & { startMin: number; endMin: number; delay?: number; line?: string }): TripLeg {
  const d = o.delay ?? 0;
  return {
    mode: "bus", transportSubmode: null,
    fromPlace: { name: "A", quay: { id: "NSR:Quay:1", name: "A" } },
    toPlace: { name: "B", quay: { id: "NSR:Quay:2", name: "B" } },
    line: { id: o.line ?? "SKY:Line:20", publicCode: "20", name: "" },
    aimedStartTime: at(o.startMin), aimedEndTime: at(o.endMin),
    expectedStartTime: at(o.startMin + d), expectedEndTime: at(o.endMin + d),
    realtime: o.realtime, duration: 0, distance: 0, intermediateQuays: [], pointsOnLink: null, serviceJourney: null,
  };
}

const hist = quantileGrid(2, 5, 9)!; // en vanlig «litt sen» buss
const median = (g: number[]) => g[Math.floor(g.length / 2)];

test("uten sanntid: historikken brukes uendret (expected = rutetid)", () => {
  const l = leg({ startMin: 10, endMin: 30, realtime: false });
  assert.equal(isLive(l), false);
  assert.deepEqual(anchoredGrid(l, "end", hist, NOW), hist);
  assert.equal(anchoredMinutes(l, "end", 2, 0.5, NOW), 2);
});

test("gammelt cache-svar uten feltene: som før (ingen sanntid, flytt 0)", () => {
  const l = leg({ startMin: 10, endMin: 30 });
  delete l.aimedStartTime; delete l.aimedEndTime; delete l.realtime;
  assert.equal(isLive(l), false);
  assert.equal(liveDelayMin(l, "end"), 0);
  assert.deepEqual(anchoredGrid(l, "end", hist, NOW), hist);
});

test("med sanntid, 6 min sen: historikken legges IKKE oppå prognosen", () => {
  const l = leg({ startMin: 10, endMin: 30, delay: 6, realtime: true });
  assert.equal(isLive(l), true);
  assert.equal(liveDelayMin(l, "end"), 6);
  const g = anchoredGrid(l, "end", hist, NOW)!;
  // Median ≈ prognosens egen skjevhet (+0–0,5 min), ikke historiske 2 min oppå +6
  assert.ok(median(g) > -0.2 && median(g) < 0.7, `median ${median(g)}`);
  assert.ok(anchoredMinutes(l, "end", 2, 0.5, NOW)! < 0.7);
});

test("med sanntid uten historikk: gir likevel en fordeling", () => {
  const l = leg({ startMin: 10, endMin: 30, delay: 3, realtime: true });
  assert.ok(anchoredGrid(l, "end", null, NOW));
});

test("Bybanen regnes aldri som sanntid (feeden har falske 0,0-rader)", () => {
  const l = leg({ startMin: 10, endMin: 30, realtime: true, line: "SKY:Line:1" });
  assert.equal(isLive(l), false);
});

test("prognosefeilen: stigende, median ≈ 0, riktig bøtte per horisont", () => {
  for (const h of [0, 3, 10, 20, 45, 120]) {
    const g = prognosisErrorGrid(h);
    for (let i = 1; i < g.length; i++) assert.ok(g[i] >= g[i - 1]);
    // Bussene går i snitt litt SENERE enn prognosen (målt +0,2–0,6 min)
    assert.ok(median(g) > -0.2 && median(g) < 0.7, `h=${h} median ${median(g)}`);
  }
  assert.equal(prognosisErrorGrid(-5), prognosisErrorGrid(0));
  assert.notEqual(prognosisErrorGrid(3), prognosisErrorGrid(10));
  // Omtrent hver femte går > 1 min tidligere enn prognosen (målt 24.11.)
  const early = gridCdf(prognosisErrorGrid(10), -1);
  assert.ok(early > 0.12 && early < 0.25, `andel tidlig ${early}`);
  assert.equal(PROGNOSIS_ERROR.every((b) => b.q.length === 20), true);
});

test("Danmarksplass: forsinket 83 du ellers ikke rakk — sjansen bygger på dagens tider", () => {
  // 20-bussen er 4 min sen og fremme om 8 min; 83 skulle gått 2 min etter
  // rutetid-ankomsten, men er 6 min sen → 4 min gap i dag (rutetid: 2 min).
  const a = leg({ startMin: -10, endMin: 4, delay: 4, realtime: true });
  const b = leg({ startMin: 6, endMin: 25, delay: 6, realtime: true, line: "SKY:Line:83" });
  const slack = (new Date(b.expectedStartTime).getTime() - new Date(a.expectedEndTime).getTime()) / 60000;
  assert.equal(slack, 4);
  const need = 1 + 2; // 1 min gange + 2 min margin
  const pLive = transferProbFromMarginals(slack, need, anchoredGrid(a, "end", hist, NOW), anchoredGrid(b, "start", hist, NOW))!;
  // Gammel modell: historikk oppå begge prognosene (telt to ganger)
  const pOld = transferProbFromMarginals(slack, need, hist, hist)!;
  assert.ok(pLive > 0.5 && pLive < 0.9, `pLive ${pLive}`);
  assert.notEqual(pLive.toFixed(3), pOld.toFixed(3));
  console.log(`      (sanntid ${Math.round(pLive * 100)} %, gammel modell ${Math.round(pOld * 100)} %)`);
});

test("bare A har sanntid: B regnes fra rutetid med sin historikk", () => {
  const a = leg({ startMin: -10, endMin: 4, delay: 5, realtime: true });
  const b = leg({ startMin: 20, endMin: 40, realtime: false, line: "SKY:Line:83" });
  assert.deepEqual(anchoredGrid(b, "start", hist, NOW), hist);
  assert.ok(anchoredGrid(a, "end", hist, NOW) !== hist);
});

test("første buss: uten sanntid gir historisk P5 minuttene på holdeplassen", () => {
  const l = leg({ startMin: 20, endMin: 40, realtime: false });
  assert.equal(boardingBufferMin(l, null, EARLY_LEVEL.normal, NOW), 0);    // ukjent → 0
  assert.equal(boardingBufferMin(l, 0.3, EARLY_LEVEL.normal, NOW), 0);     // går aldri før
  assert.equal(boardingBufferMin(l, -0.4, EARLY_LEVEL.normal, NOW), 0);    // et halvt minutt er toleransen
  assert.equal(boardingBufferMin(l, -1.2, EARLY_LEVEL.normal, NOW), 1);
  assert.equal(boardingBufferMin(l, -2.1, EARLY_LEVEL.normal, NOW), 2);
});

test("første buss: Bybanen får aldri buffer", () => {
  const l = leg({ startMin: 20, endMin: 40, realtime: true, line: "SKY:Line:2" });
  assert.equal(boardingBufferMin(l, -3, EARLY_LEVEL.high, NOW), 0);
});

test("første buss: sanntid — sen buss kan ta igjen, men ikke gå før rutetid", () => {
  // I rute ifølge prognosen, historisk aldri før rutetid → ingen buffer
  const onTime = leg({ startMin: 10, endMin: 30, delay: 0, realtime: true });
  assert.equal(boardingBufferMin(onTime, 0.2, EARLY_LEVEL.normal, NOW), 0);
  // 5 min sen ifølge prognosen: prognosefeilen styrer (kan ta igjen), > 0
  const late = leg({ startMin: 10, endMin: 30, delay: 5, realtime: true });
  const b = boardingBufferMin(late, -0.2, EARLY_LEVEL.normal, NOW);
  assert.ok(b >= 1 && b <= 5, `b ${b}`);
  // ... men aldri mer enn forsinkelsen + historisk tidlig-hale
  assert.ok(boardingBufferMin(late, -0.2, 0.001, NOW) <= 5);
});

test("første buss: for få dager gir ingen persentil; høy sikkerhet faller tilbake til P5", () => {
  assert.equal(earlyQuantile({ p02: -3, p05: -2, n: 10 }, "normal"), null);
  assert.equal(earlyQuantile({ p02: -3, p05: -2, n: 20 }, "normal"), -2);
  assert.equal(earlyQuantile({ p02: -3, p05: -2, n: 20 }, "high"), -2);
  assert.equal(earlyQuantile({ p02: -3, p05: -2, n: 60 }, "high"), -3);
  assert.equal(earlyQuantile(undefined, "high"), null);
});

console.log(`${n} tester ok`);
