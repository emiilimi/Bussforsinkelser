// ---------------------------------------------------------------------------
// Sanntid i reisemodellen (2026-11-25).
//
// Enturs `expected*` er rutetid når legget ikke har sanntid, og en PROGNOSE når
// det har det. Våre historiske forsinkelser er målt mot RUTETIDEN. Før dette
// ble historikken lagt oppå expected uansett — en buss som allerede var 6 min
// sen fikk 6 min + sin vanlige forsinkelse (telt to ganger), og byttesjansen
// visste ikke at bussen var sen akkurat nå.
//
// Regelen:
//   - Legg UTEN sanntid: historisk fordeling, forankret i rutetiden
//     (= expected − (expected − aimed); uten sanntid er de like).
//   - Legg MED sanntid: Enturs prognose + prognosefeilen for så lang tid før
//     (PROGNOSIS_ERROR). Historikken for avgangen brukes ikke — den vet ikke
//     hva som skjer i dag.
//
// Alle fordelinger her er minutter RELATIVT TIL legets expected-tid, slik at
// resten av modellen (slack = expected B − expected A) kan stå uendret.
// ---------------------------------------------------------------------------

import { GRID, type QGrid, referenceFor } from "@/lib/trip-model";
import type { TripLeg } from "@/lib/trip-shared";

/**
 * Faktisk − prognose (min) for Enturs expectedDepartureTime, etter hvor lang
 * tid før avgang prognosen ble gitt. 20 kvantiler, nivå 0,025, 0,075 … 0,975.
 *
 * Målt 24.11.2026 (pipeline/triplab/entur_estimates.py snapshot + evaluate):
 * 60 plattformer i Oslo, Bergen, Trondheim, Stavanger og Kristiansand, hvert
 * 10. min i 2 timer, mot faktisk avgang fra SIRI ET. Bare legg med
 * realtime = true. ÉN dag — mål på nytt (snapshot → evaluate) før du stoler på
 * halene. Venstre hale (gikk FØR prognosen) er like tung som høyre: omtrent
 * hver femte buss går > 1 min tidligere enn skjermen sa.
 */
export const PROGNOSIS_ERROR: ReadonlyArray<{ maxMin: number; n: number; q: readonly number[] }> = [
  { maxMin: 4, n: 499, q: [-6.5, -2.6, -1.8, -1.2, -0.6, -0.4, -0.2, -0.0, 0.0, 0.1, 0.3, 0.4, 0.5, 0.8, 1.1, 1.5, 2.0, 2.7, 4.2, 6.9] },
  { maxMin: 14, n: 954, q: [-5.3, -2.8, -1.6, -0.8, -0.5, -0.3, -0.0, 0.1, 0.2, 0.4, 0.6, 0.7, 1.0, 1.3, 1.6, 2.0, 2.4, 3.3, 4.7, 7.4] },
  { maxMin: 29, n: 1347, q: [-5.6, -2.6, -1.6, -1.0, -0.7, -0.5, -0.2, 0.0, 0.2, 0.4, 0.6, 0.8, 1.1, 1.4, 1.7, 2.1, 2.8, 3.8, 5.2, 7.9] },
  // Brukes også over 60 min (ikke målt der).
  { maxMin: 60, n: 2061, q: [-4.5, -2.3, -1.5, -1.0, -0.8, -0.5, -0.2, -0.0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.2, 1.5, 1.8, 2.4, 3.3, 4.7, 7.1] },
];

/** Hvor mange dager et sanntidsbasert bytte-estimat teller som i «Viktig
 *  avtale»-grensen (lowerBound). Prognosefeilen er målt på hundrevis av
 *  avganger, men bare én dag — derfor ikke mer enn noen uker. */
export const LIVE_NEFF = 30;

const LEVELS = PROGNOSIS_ERROR[0].q.map((_, i) => 0.025 + 0.05 * i);

function gridFromQuantiles(q: readonly number[]): QGrid {
  const n = q.length;
  return GRID.map((u) => {
    if (u <= LEVELS[0]) return q[0] - ((q[1] - q[0]) * (LEVELS[0] - u)) / 0.05;
    if (u >= LEVELS[n - 1]) return q[n - 1] + ((q[n - 1] - q[n - 2]) * (u - LEVELS[n - 1])) / 0.05;
    const k = Math.floor((u - LEVELS[0]) / 0.05);
    const f = (u - LEVELS[k]) / 0.05;
    return q[k] + (q[k + 1] - q[k]) * f;
  });
}

const ERROR_GRIDS = PROGNOSIS_ERROR.map((b) => ({ maxMin: b.maxMin, grid: gridFromQuantiles(b.q) }));

/** Prognosefeilen som fordeling, for en prognose `horizonMin` før hendelsen. */
export function prognosisErrorGrid(horizonMin: number): QGrid {
  const h = Math.max(0, horizonMin);
  return (ERROR_GRIDS.find((b) => h <= b.maxMin) ?? ERROR_GRIDS[ERROR_GRIDS.length - 1]).grid;
}

export type LegSide = "start" | "end";

const minutes = (a: string, b: string) => (new Date(a).getTime() - new Date(b).getTime()) / 60000;

/** Har legget en sanntidsprognose vi skal bruke? Kildebelagte linjer
 *  (Bybanen) aldri — feeden deres har ikke ekte sanntid. */
export function isLive(leg: TripLeg): boolean {
  return leg.realtime === true && !referenceFor(leg.line?.id);
}

/** expected − aimed (min) for avgang/ankomst. 0 når rutetiden mangler. */
export function liveDelayMin(leg: TripLeg, side: LegSide): number {
  const exp = side === "start" ? leg.expectedStartTime : leg.expectedEndTime;
  const aim = side === "start" ? leg.aimedStartTime : leg.aimedEndTime;
  if (!aim) return 0;
  const d = minutes(exp, aim);
  return Number.isFinite(d) ? d : 0;
}

/**
 * Forsinkelsesfordelingen for én side av et legg, i minutter relativt til
 * legets EXPECTED-tid.
 *   hist = historisk forsinkelse målt mot rutetid (null = ingen data)
 * Med sanntid: prognosefeilen (finnes alltid). Uten: historikken flyttet så
 * den måles fra expected (uten sanntid er expected = rutetid, flytt 0).
 */
export function anchoredGrid(leg: TripLeg, side: LegSide, hist: QGrid | null, nowMs = Date.now()): QGrid | null {
  if (isLive(leg)) {
    const exp = side === "start" ? leg.expectedStartTime : leg.expectedEndTime;
    return prognosisErrorGrid((new Date(exp).getTime() - nowMs) / 60000);
  }
  if (!hist) return null;
  const d = liveDelayMin(leg, side);
  return d === 0 ? hist : hist.map((v) => v - d);
}

// ---------------------------------------------------------------------------
// Rekker du FØRSTE buss? (2026-11-25)
//
// «Dra kl.» var legets avgangstid: står du på holdeplassen akkurat da, rekker
// du bussen bare hvis den ikke går før. Målt uke 46–47 (buss): Skyss går
// > 1 min før rutetid i 5,6 % av avgangene, Nordland 5,1 %, Kolumbus 4,5 %,
// Ruter 0,1 %. Sanntidsprognosen bommer også nedover (~1 av 5 går > 1 min før
// prognosen, se PROGNOSIS_ERROR).
//
// Regelen: vær på holdeplassen så tidlig at bussen har gått før deg høyst
// EARLY_LEVEL av dagene (1 av 20 vanlig dag, 1 av 50 viktig avtale). Et halvt
// minutt før er ikke å «gå før deg» (måleoppløsning, og du står ikke på
// sekundet) — derfor EARLY_TOLERANCE_MIN.
// ---------------------------------------------------------------------------

export const EARLY_LEVEL = { normal: 0.05, high: 0.02 } as const;
export const EARLY_TOLERANCE_MIN = 0.5;
/** Færre observasjoner enn dette: nedre persentil er bare den laveste verdien. */
export const EARLY_MIN_N = { normal: 15, high: 40 } as const;

/** Historisk nedre persentil for nivået, eller null når grunnlaget er for tynt.
 *  «Viktig avtale» faller tilbake til P5 når det er for få dager for P2. */
export function earlyQuantile(
  r: { p02?: number | null; p05?: number | null; n: number } | null | undefined,
  certainty: keyof typeof EARLY_LEVEL,
): number | null {
  if (!r) return null;
  if (certainty === "high" && r.n >= EARLY_MIN_N.high && r.p02 != null) return r.p02;
  return r.n >= EARLY_MIN_N.normal && r.p05 != null ? r.p05 : null;
}

/**
 * Hele minutter før legets EXPECTED avgang du bør stå på holdeplassen.
 *   histQ = historisk forsinkelse ved nivået (negativ = gikk før rutetid),
 *           null = ukjent
 * Uten sanntid: −histQ (forankret i rutetiden).
 * Med sanntid: prognosefeilen ved nivået, men aldri mer enn bussen har gått
 * før RUTETIDEN historisk — en sen buss kan ta igjen, men går sjelden før
 * rutetid (uten historikk: antatt ikke før rutetid).
 */
export function boardingBufferMin(
  leg: TripLeg, histQ: number | null, level: number, nowMs = Date.now(),
): number {
  if (referenceFor(leg.line?.id)) return 0;
  const d = liveDelayMin(leg, "start");
  let b: number;
  if (isLive(leg)) {
    const g = prognosisErrorGrid((new Date(leg.expectedStartTime).getTime() - nowMs) / 60000);
    const q = g[Math.min(g.length - 1, Math.max(0, Math.round(level * g.length - 0.5)))];
    b = Math.min(-q, d - Math.min(histQ ?? 0, 0));
  } else {
    if (histQ == null) return 0;
    b = d - histQ;
  }
  return Math.max(0, Math.ceil(b - EARLY_TOLERANCE_MIN - 1e-9));
}

/** Ett tall på samme måte: minutter å legge til expected-tiden.
 *  `histMin` er den historiske persentilen på nivå `level` (0,5 = median). */
export function anchoredMinutes(
  leg: TripLeg, side: LegSide, histMin: number | null | undefined, level = 0.5, nowMs = Date.now(),
): number | null {
  if (isLive(leg)) {
    const exp = side === "start" ? leg.expectedStartTime : leg.expectedEndTime;
    const g = prognosisErrorGrid((new Date(exp).getTime() - nowMs) / 60000);
    return g[Math.min(g.length - 1, Math.max(0, Math.round(level * g.length - 0.5)))];
  }
  if (histMin == null) return null;
  return histMin - liveDelayMin(leg, side);
}
