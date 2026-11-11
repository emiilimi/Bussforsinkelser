/**
 * Overgangs- og ankomstmodellen i reiseplanleggeren (utkast 2026-11-11).
 *
 * Fire byggeklosser, alle rene funksjoner (ingen React, ingen DuckDB):
 *
 *  1. KILDEBELAGT PÅLITELIGHET for linjer der sanntidsdataene våre ikke er
 *     ekte målinger (Bybanen). Tallene kommer fra operatørens egen rapport og
 *     står med kilde i REFERENCE_LINES — ikke «Bybanen er sikker» hardkodet.
 *
 *  2. MARGINAL-ESTIMAT for overganger vi har få eller ingen felles dager for:
 *     om du rekker byttet avhenger av når buss A kommer fram og når B går. Har
 *     vi ikke sett de to avgangene SAMMEN, har vi nesten alltid sett hver av
 *     dem for seg (P50/P80/P95 per linje og stopp). Vi antar uavhengighet og
 *     regner P(planlagt gap + B sin forsinkelse − A sin forsinkelse ≥ gange +
 *     margin). Uavhengighet er forsiktig: i virkeligheten står A og B ofte i
 *     samme kø, og det hjelper deg.
 *
 *  3. LÅNT STYRKE: målte dager og marginal-estimatet veies sammen
 *     (MARGINAL_PRIOR_DAYS). Mange målte dager → nesten bare dem; få → mest
 *     marginalen. Antall «effektive dager» gir også en usikkerhet, som
 *     «Viktig avtale» bruker (forsiktig nedre grense).
 *
 *  4. ANKOMST SOM BLANDING: med sannsynlighet pMake rekker du byttet og
 *     kommer fram etter plan A; ellers med neste avgang (plan B, fra Entur).
 *         P(fremme innen t) = pMake·F_A(t) + (1 − pMake)·F_B(t)
 *     Uten plan B regnes miss-grenen som «for sent» — det er det samme som den
 *     gamle arrivalQuantileLevel-regelen (F_A(t) ≥ 0,8/pMake).
 *
 * Og en beslutningsregel: anbefalingen veier ventetid mot risikoen for å komme
 * for sent (LATE_COST_MIN), i stedet for en fast 80 %-grense. En bane hvert 5.
 * minutt gjør det billig å være forsiktig; en buss i timen gjør det dyrt.
 *
 * Kvantil-rutenettet og transferProbFromMarginals MÅ være identiske med
 * pipeline/backtest_marginal.py, som er grunnlaget for konstantene.
 */

// ---------------------------------------------------------------------------
// 1. Kildebelagt pålitelighet
// ---------------------------------------------------------------------------

export type ReferenceReliability = {
  /** Vanlig navn i setninger («Bybanen linje 1»). */
  name: string;
  /** Andel avganger i rute — operatørens egen definisjon: «ankomme og gå i
   *  henhold til rutetabellen» (minuttgrense ikke oppgitt i rapporten). */
  punctuality: number;
  /** Andel planlagte avganger som faktisk gikk (1 − innstilte). */
  regularity: number;
  year: number;
  source: string;
  url: string;
};

/**
 * Linjer der vi bruker operatørens publiserte tall i stedet for egne målinger.
 *
 * Bybanen (SKY:Line:1/2 hos Entur) mangler i praksis i SIRI ET-dataene: målt
 * 2026-11-11 hadde linje 1 bare to dager med mange rader (16. og 19.10), og
 * der var forsinkelsen nøyaktig 0,0 på alle 3 102 radene — rutetider sendt som
 * om de var målt, ikke sanntid. Egen «statistikk» for Bybanen er derfor verre
 * enn ingen. Se STATUS.md 2026-11-11.
 *
 * Legg bare til linjer med en etterprøvbar kilde, og oppdater når ny rapport
 * kommer.
 */
export const REFERENCE_LINES: Record<string, ReferenceReliability> = {
  "SKY:Line:1": {
    name: "Bybanen linje 1",
    punctuality: 0.993,
    regularity: 0.959,
    year: 2023,
    source: "Bybanen AS, bærekraftsrapport 2023",
    url: "https://bybanen.no/baerekraftsrapport_2023_oppslag",
  },
  "SKY:Line:2": {
    name: "Bybanen linje 2",
    punctuality: 0.997,
    regularity: 0.977,
    year: 2023,
    source: "Bybanen AS, bærekraftsrapport 2023",
    url: "https://bybanen.no/baerekraftsrapport_2023_oppslag",
  },
};

export function referenceFor(lineRef: string | null | undefined): ReferenceReliability | null {
  return lineRef ? REFERENCE_LINES[lineRef] ?? null : null;
}

/** Hvor mange «dager» et kildebelagt tall teller som i usikkerheten. Det er
 *  et helt års drift, men ikke for akkurat din avgang — så sterkt, ikke uendelig. */
export const REFERENCE_DAYS = 60;

/** Ventetid (min) når en kildebelagt avgang er innstilt eller for sen: neste
 *  avgang. Bybanen går hvert 5.–10. minutt det meste av dagen. */
export const REFERENCE_MISS_MIN = 10;

/** Ankomstforsinkelse for et legg med kildebelagt pålitelighet: i rute med
 *  sannsynlighet regularitet × punktlighet, ellers neste avgang. */
export function referenceGrid(ref: ReferenceReliability): QGrid {
  const ok = ref.regularity * ref.punctuality;
  return GRID.map((u) => (u <= ok ? 0 : REFERENCE_MISS_MIN));
}

// ---------------------------------------------------------------------------
// Kvantil-rutenett: en fordeling = forsinkelsen (min) på 100 faste nivåer
// ---------------------------------------------------------------------------

export const GRID: readonly number[] = Array.from({ length: 100 }, (_, i) => (i + 0.5) / 100);
/** Forsinkelse (minutter) på GRID-nivåene, stigende. */
export type QGrid = number[];
export const ZERO_GRID: QGrid = GRID.map(() => 0);

/**
 * Fordeling ut fra de tre persentilene vi har. Under medianen speiles en
 * moderat spredning (maks 3 min), over P95 forlenges halen med dobbel
 * stigning — vi vet at halen er tyngre enn P80→P95 tilsier, men ikke hvor mye.
 */
export function quantileGrid(
  p50: number | null | undefined,
  p80: number | null | undefined,
  p95: number | null | undefined,
): QGrid | null {
  const vals = [p50, p80, p95].filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length === 0) return null;
  let a = p50 ?? vals[0];
  let b = p80 ?? p95 ?? a;
  let c = p95 ?? b;
  b = Math.max(b, a);
  c = Math.max(c, b);
  const lo = Math.min(Math.max(b - a, 0.5), 3);
  const tail = Math.max(c - b, 1);
  return GRID.map((u) => {
    if (u <= 0.5) return a - (lo * (0.5 - u)) / 0.3;
    if (u <= 0.8) return a + ((b - a) * (u - 0.5)) / 0.3;
    if (u <= 0.95) return b + ((c - b) * (u - 0.8)) / 0.15;
    return c + (2 * tail * (u - 0.95)) / 0.15;
  });
}

/** Verste av to fordelinger, nivå for nivå («det tregeste legget»). */
export function maxGrid(x: QGrid | null, y: QGrid | null): QGrid | null {
  if (!x) return y;
  if (!y) return x;
  return x.map((v, i) => Math.max(v, y[i]));
}

export function shiftGrid(q: QGrid, minutes: number): QGrid {
  return q.map((v) => v + minutes);
}

/** P(X ≤ x) for en rutenett-fordeling, lineært mellom nivåene. */
export function gridCdf(q: QGrid, x: number): number {
  const n = q.length;
  if (x < q[0]) return 0;
  if (x >= q[n - 1]) return 1;
  // Binærsøk etter siste indeks med q[i] <= x
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (q[mid] <= x) lo = mid; else hi = mid;
  }
  const span = q[hi] - q[lo];
  const frac = span > 0 ? (x - q[lo]) / span : 1;
  return GRID[lo] + frac * (GRID[hi] - GRID[lo]);
}

// ---------------------------------------------------------------------------
// 2–3. Overgang: marginal-estimat og sammenveiing
// ---------------------------------------------------------------------------

/**
 * P(rekker byttet) fra hver linjes fordeling alene, antatt uavhengige.
 *   slack = planlagt tid fra A er fremme til B går (min, inkl. gange)
 *   need  = gange + margin (min)
 * dep = null: B sin forsinkelse ukjent → regnes som i rute (forsiktig: en
 * forsinket B hjelper deg). null hvis A sin fordeling mangler.
 */
export function transferProbFromMarginals(
  slack: number,
  need: number,
  arr: QGrid | null,
  dep: QGrid | null,
): number | null {
  if (!arr) return null;
  const d = dep ?? [0];
  let made = 0;
  for (const a of arr) for (const b of d) if (slack + b - a >= need) made++;
  return made / (arr.length * d.length);
}

/**
 * Hvor mange dager marginal-estimatet teller som når det veies mot målte
 * overgangsdager. pipeline/backtest_marginal.py, 2026-11-11 (51 stoppesteder,
 * 6 000 ekte overgangspar, ~256 000 måldager, hverdager, buffer 3 min), Brier:
 *
 *   felles dager   bare målte   bare marginal   veid, M = 10
 *        0             —            0,1218          0,1218   (flat snittrate: 0,1728)
 *        1           0,2160         0,1218          0,1203
 *        3           0,1442         0,1218          0,1182
 *       10           0,1188         0,1217          0,1142
 *       alle         0,1090         0,1218          0,1090
 *
 * M = 10 var best for 1–10 dager (M = 2, 5, 20 testet). Med egne dager i
 * tillegg endret marginalen ingenting (0,1064 begge) — den skader ikke der vi
 * allerede har mye data. Marginalen alene er litt forsiktig i midten (spådd
 * 0,75 → faktisk 0,82), som ventet når samme kø hjelper begge bussene.
 * Kjør backtesten på nytt før du endrer tallet.
 */
export const MARGINAL_PRIOR_DAYS = 10;

export type TransferBasis =
  /** Mest målte felles dager for de to avgangene */
  | "measured"
  /** Få målte dager, veid mot linjenes egne fordelinger */
  | "blend"
  /** Ingen felles dager — bare linjenes egne fordelinger */
  | "marginal"
  /** Byttet er til/fra en linje med kildebelagt pålitelighet */
  | "reference"
  /** Ingenting å regne på */
  | "none";

export type TransferEstimate = { p: number; nEff: number; basis: TransferBasis };

/**
 * Veier målte dager (pJoint over nJoint dager, -1 = ingen) mot marginal-
 * estimatet (null = ukjent):  p = (n·p_målt + M·p_marg) / (n + M).
 */
export function blendTransfer(pJoint: number, nJoint: number, pMarg: number | null): TransferEstimate {
  const hasJoint = pJoint >= 0 && nJoint > 0;
  if (!hasJoint && pMarg == null) return { p: -1, nEff: 0, basis: "none" };
  if (!hasJoint) return { p: pMarg!, nEff: MARGINAL_PRIOR_DAYS, basis: "marginal" };
  if (pMarg == null) return { p: pJoint, nEff: nJoint, basis: "measured" };
  const m = MARGINAL_PRIOR_DAYS;
  return {
    p: (nJoint * pJoint + m * pMarg) / (nJoint + m),
    nEff: nJoint + m,
    basis: nJoint >= 4 * m ? "measured" : "blend",
  };
}

/**
 * Forsiktig nedre grense for en sannsynlighet målt over nEff dager — én-sidig
 * ~90 % (z = 1,28), normaltilnærming. Få dager → tydelig lavere; mange → nesten
 * p. Brukes av «Viktig avtale», der det å stole for mye på tynne data koster mest.
 */
export function lowerBound(p: number, nEff: number, z = 1.28): number {
  if (p < 0) return p;
  if (nEff <= 0) return 0;
  // +1 dag i nevneren: ingen spredning ved p = 1 betyr ikke null usikkerhet.
  return Math.max(0, p - z * Math.sqrt((p * (1 - p) + 0.25 / (nEff + 1)) / (nEff + 1)));
}

// ---------------------------------------------------------------------------
// 4. Ankomst som blandingsfordeling
// ---------------------------------------------------------------------------

/** Minutter relativt til plan A sin planlagte ankomst. */
export type ArrivalMixture = {
  /** Sannsynligheten for å rekke alle byttene (1 = ingen bytter). */
  pMake: number;
  /** Ankomstforsinkelse hvis alt går etter plan A. */
  a: QGrid;
  /** Ankomst med plan B (forskjøvet), null = ukjent → regnes som for sent. */
  b: QGrid | null;
};

export function mixtureCdf(m: ArrivalMixture, t: number): number {
  const fa = gridCdf(m.a, t);
  const fb = m.b ? gridCdf(m.b, t) : 0;
  return m.pMake * fa + (1 - m.pMake) * fb;
}

/** Tidligste t (min) med P(fremme innen t) ≥ level, null hvis aldri. */
export function mixtureQuantile(m: ArrivalMixture, level: number): number | null {
  const ceiling = m.pMake + (m.b ? 1 - m.pMake : 0);
  if (ceiling + 1e-9 < level) return null;
  let lo = Math.min(m.a[0], m.b ? m.b[0] : Infinity) - 1;
  let hi = Math.max(m.a[m.a.length - 1], m.b ? m.b[m.b.length - 1] : -Infinity);
  if (mixtureCdf(m, hi) + 1e-9 < level) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (mixtureCdf(m, mid) >= level) hi = mid; else lo = mid;
  }
  return hi;
}

// ---------------------------------------------------------------------------
// Beslutning: ventetid mot risiko
// ---------------------------------------------------------------------------

export type CertaintyLevel = "normal" | "high";

/**
 * Hvor mange minutters venting det er verdt å unngå å komme for sent.
 *  - normal: én time. Gir omtrent «fire av fem dager» når avgangene går hvert
 *    kvarter, og strengere når de går ofte (forsiktighet er billig).
 *  - high («Viktig avtale»): fem timer — omtrent «19 av 20 dager» ved kvarters-
 *    frekvens.
 */
export const LATE_COST_MIN: Record<CertaintyLevel, number> = { normal: 60, high: 300 };
/** Under dette anbefales ikke en avgang uansett hvor kort ventetiden er. */
export const MIN_ON_TIME: Record<CertaintyLevel, number> = { normal: 0.6, high: 0.85 };

export function decisionCost(waitMin: number, pOnTime: number, c: CertaintyLevel): number {
  return Math.max(0, waitMin) + LATE_COST_MIN[c] * (1 - pOnTime);
}

/** «fire av fem dager» o.l. — nærmeste enkle brøk, uten prosent. */
export function frequencyWords(p: number): string {
  if (p >= 0.95) return "nesten alltid";
  if (p >= 0.875) return "ni av ti dager";
  if (p >= 0.775) return "fire av fem dager";
  if (p >= 0.7) return "tre av fire dager";
  if (p >= 0.58) return "to av tre dager";
  return "omtrent annenhver dag";
}
