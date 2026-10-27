/**
 * Tolker /api/line/:ref/distribution (apiLineDistribution i stats-adapter.ts)
 * til det linjeanalysen tegner: nøkkeltall, histogram, varmekart ukedag × time
 * og en dagsserie. Se adapteren for radformatet (kind 0/1/2).
 */

/** Bøtter per minutt. MÅ være lik DIST_BIN_PER_MIN i stats-adapter.ts. */
export const DIST_BIN_PER_MIN = 4;

export type DistRow = {
  kind: number;
  date: string | null;
  dow: number | null;
  hour: number | null;
  b: number | null;
  n: number;
  s: number;
  early: number;
  punctual: number;
  late10: number;
  p50: number | null;
  p80: number | null;
  p95: number | null;
  sd: number | null;
  deps: number | null;
};

/** Andeler i prosent. «I rute» er −1..+2 min, altså UTEN de som gikk for
 *  tidlig — samme som pctPunctual på Oversikt og Topplister. */
export type Shares = {
  n: number;
  mean: number | null;
  pctEarly: number | null;
  pctPunctual: number | null;
  pctLate: number | null;
  pctLate10: number | null;
};

export type DistOverall = Shares & {
  p50: number | null;
  p80: number | null;
  p95: number | null;
  sd: number | null;
  deps: number | null;
};

export type HistBar = {
  /** Nedre grense i minutter. Første og siste søyle samler halene. */
  from: number;
  to: number;
  label: string;
  n: number;
  pct: number;
  zone: "early" | "punctual" | "late" | "late10";
};

export type HeatCell = Shares & { dow: number; hour: number; p80: number | null };

export type DailyPoint = Shares & {
  date: string;
  p50: number | null;
  p80: number | null;
  deps: number | null;
};

export type LineDistribution = {
  overall: DistOverall;
  hist: HistBar[];
  /** dow 1–7 (ISO, mandag = 1), og 0 = alle dager. */
  cells: Map<string, HeatCell>;
  hours: number[];
  daily: DailyPoint[];
};

export const cellKey = (dow: number, hour: number) => `${dow}-${hour}`;

function shares(r: { n: number; s: number; early: number; punctual: number; late10: number }): Shares {
  if (!r.n) return { n: 0, mean: null, pctEarly: null, pctPunctual: null, pctLate: null, pctLate10: null };
  const pctEarly = (100 * r.early) / r.n;
  const pctPunctual = (100 * r.punctual) / r.n;
  return {
    n: r.n,
    mean: r.s / r.n,
    pctEarly,
    pctPunctual,
    pctLate: Math.max(0, 100 - pctEarly - pctPunctual),
    pctLate10: (100 * r.late10) / r.n,
  };
}

/** Kvantil fra kvartersbøtter, lineært innen bøtta. bins: [b, n] sortert på b. */
export function quantileFromBins(bins: Array<[number, number]>, p: number): number | null {
  const total = bins.reduce((s, [, n]) => s + n, 0);
  if (!total) return null;
  const target = p * total;
  let acc = 0;
  for (const [b, n] of bins) {
    if (acc + n >= target) {
      const frac = n ? (target - acc) / n : 0;
      return (b + frac) / DIST_BIN_PER_MIN;
    }
    acc += n;
  }
  return (bins[bins.length - 1][0] + 1) / DIST_BIN_PER_MIN;
}

const HIST_MIN = -5;
const HIST_MAX = 20;

function zoneOf(from: number): HistBar["zone"] {
  if (from < -1) return "early";
  if (from < 2) return "punctual";
  if (from < 10) return "late";
  return "late10";
}

export function parseDistribution(rows: DistRow[]): LineDistribution | null {
  const overallRow = rows.find((r) => r.kind === 2);
  if (!overallRow || !overallRow.n) return null;

  // Histogram: hele minutter fra HIST_MIN til HIST_MAX, halene i endesøylene.
  const perMinute = new Map<number, number>();
  const cellAcc = new Map<string, { n: number; s: number; early: number; punctual: number; late10: number; bins: Map<number, number> }>();
  const hoursSeen = new Set<number>();
  for (const r of rows) {
    if (r.kind !== 0 || r.b == null || r.dow == null || r.hour == null) continue;
    const minute = Math.min(HIST_MAX, Math.max(HIST_MIN, Math.floor(r.b / DIST_BIN_PER_MIN)));
    perMinute.set(minute, (perMinute.get(minute) ?? 0) + r.n);
    hoursSeen.add(r.hour);
    for (const dow of [r.dow, 0]) {
      const k = cellKey(dow, r.hour);
      let c = cellAcc.get(k);
      if (!c) cellAcc.set(k, (c = { n: 0, s: 0, early: 0, punctual: 0, late10: 0, bins: new Map() }));
      c.n += r.n;
      c.s += r.s;
      c.early += r.early;
      c.punctual += r.punctual;
      c.late10 += r.late10;
      c.bins.set(r.b, (c.bins.get(r.b) ?? 0) + r.n);
    }
  }

  const histTotal = Array.from(perMinute.values()).reduce((s, n) => s + n, 0) || 1;
  const hist: HistBar[] = [];
  for (let m = HIST_MIN; m <= HIST_MAX; m++) {
    const n = perMinute.get(m) ?? 0;
    const label = m === HIST_MIN ? `≤ ${m + 1}` : m === HIST_MAX ? `≥ ${m}` : `${m}`;
    hist.push({ from: m, to: m + 1, label, n, pct: (100 * n) / histTotal, zone: zoneOf(m) });
  }

  const cells = new Map<string, HeatCell>();
  cellAcc.forEach((c, k) => {
    const [dow, hour] = k.split("-").map(Number);
    const bins = Array.from(c.bins.entries()).sort((a, b) => a[0] - b[0]);
    cells.set(k, { ...shares(c), dow, hour, p80: quantileFromBins(bins, 0.8) });
  });

  // Nattetimene etter midnatt (0–4) sist, så aksen følger driftsdøgnet.
  const hours = Array.from(hoursSeen).sort((a, b) => ((a + 20) % 24) - ((b + 20) % 24));

  const daily: DailyPoint[] = rows
    .filter((r) => r.kind === 1 && r.date)
    .map((r) => ({ ...shares(r), date: r.date!.slice(0, 10), p50: r.p50, p80: r.p80, deps: r.deps }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    overall: {
      ...shares(overallRow),
      p50: overallRow.p50,
      p80: overallRow.p80,
      p95: overallRow.p95,
      sd: overallRow.sd,
      deps: overallRow.deps,
    },
    hist,
    cells,
    hours,
    daily,
  };
}

/** «+3,6 min» / «−0,4 min» med norsk desimalkomma og ekte minustegn. */
export function fmtSignedMin(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const r = Number(v.toFixed(digits));
  const abs = Math.abs(r).toLocaleString("nb-NO", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${abs} min`;
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toLocaleString("nb-NO", { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

/** «4 av 5», «1 av 20» o.l. for en andel — brukes i overskriften. */
export function shareInWords(pct: number): string {
  const options: Array<[number, number]> = [
    [9, 10], [4, 5], [3, 4], [2, 3], [3, 5], [1, 2], [2, 5], [1, 3], [1, 4], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100],
  ];
  let best = options[0];
  for (const o of options) {
    if (Math.abs((100 * o[0]) / o[1] - pct) < Math.abs((100 * best[0]) / best[1] - pct)) best = o;
  }
  return `${best[0]} av ${best[1]}`;
}

export const DOW_SHORT = ["Alle", "Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];
export const DOW_LONG = ["Alle dager", "Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"];
