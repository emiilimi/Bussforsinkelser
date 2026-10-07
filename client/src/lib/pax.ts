// ---------------------------------------------------------------------------
// Passasjertellinger (samferdselsdata.no / Entur, beta) — klientside.
//
// Artefaktene lages av pipeline/passenger_stats.py:
//   <PAX_BASE>/summary.json            operatør-KPI, linjeliste, last vs forsinkelse …
//   <PAX_BASE>/lines/<OP_Line_X>.json  per linje: avganger med belegg per stopp
//
// PÅ når passasjerfilene har en adresse:
//   1) VITE_PAX_BASE_URL ved bygg (lokalt: /pax-dev), ellers
//   2) <VITE_PARQUET_BASE_URL>/pax — samme R2-bøtte som parquet-filene. Det er
//      slik sentur.no og forhåndsvisningene får den.
// Nødbryter: VITE_PAX_DISABLED=1 ved bygg skjuler alt (menypunkt, side, merker).
//
// Lisens: samferdselsdata.no oppgir ingen lisens og ber om avklaring med
// dataeier før publisering. Emilie fikk tillatelse 2026-10-07; funksjonen ble
// da slått på i produksjon. Siden viser fortsatt kildens egne forbehold
// (kortet «Om passasjertallene» i passengers.tsx) og lenker til kilden.
// ---------------------------------------------------------------------------

import { useQuery } from "@tanstack/react-query";

const ENV = (import.meta as any).env ?? {};
const ENV_BASE = String(ENV.VITE_PAX_BASE_URL ?? "").trim().replace(/\/+$/, "");
// Samme R2-base som parquet-filene (use-parquet-query.ts), men lest direkte
// her: å importere den hooken ville dratt DuckDB inn i menyens bunt.
const R2_BASE = String(ENV.VITE_PARQUET_BASE_URL ?? "").trim().replace(/\/+$/, "");
const DISABLED = String(ENV.VITE_PAX_DISABLED ?? "") === "1";
export const PAX_BASE: string = DISABLED ? "" : ENV_BASE || (R2_BASE ? `${R2_BASE}/pax` : "");
export const PAX_ENABLED: boolean = PAX_BASE.length > 0;

/** Kilde og dokumentasjon — vises på siden og i merkene. */
export const PAX_SOURCE = {
  name: "Passasjertellinger (beta) — samferdselsdata.no / Entur",
  url: "https://samferdselsdata.no/dataprodukter/passasjertellinger",
  docsUrl: "https://samferdselsdata.no/dataprodukter/passasjertellinger/?tab=dokumentasjon",
  structureUrl: "https://samferdselsdata.no/dataprodukter/passasjertellinger/?tab=datastruktur",
};

/** Operatører med per-avgang-tellinger. Må holdes i takt med OPERATORS i passenger_stats.py. */
export const PAX_OPERATORS = ["KOL", "OST", "TRO"] as const;
export type PaxOperator = (typeof PAX_OPERATORS)[number];

export function isPaxOperator(op: string | null | undefined): op is PaxOperator {
  return !!op && (PAX_OPERATORS as readonly string[]).includes(op);
}

export function lineOperator(lineRef: string | null | undefined): string | null {
  return lineRef ? lineRef.split(":")[0] : null;
}

// ---------------------------------------------------------------------------
// Typer (speiler JSON-en fra passenger_stats.py)
// ---------------------------------------------------------------------------

export type PaxKpi = {
  month: string;
  boardings: number;
  paxHoursLost: number | null;
  paxDelay: number | null;
  paxOnTime: number | null;
  paxLate5: number | null;
  stopDelay: number | null;
  stopOnTime: number | null;
  lines: number;
  coverageBoardings: number | null;
  coverageAlightings: number | null;
  /** andel avganger (%) med 0 på og 0 av hele måneden = ikke telt */
  uncountedDeps?: number | null;
};

export type PaxOperatorSummary = {
  code: PaxOperator;
  name: string;
  county: string;
  months: string[];
  latestMonth: string;
  kpi: PaxKpi[];
  history: [string, number][];
};

export type PaxLineSummary = {
  lineRef: string;
  op: PaxOperator;
  code: string | null;
  name: string | null;
  mode: string | null;
  month: string;
  boardings: number;
  paxHoursLost: number | null;
  paxDelay: number | null;
  paxOnTime: number | null;
  paxLate5: number | null;
  stopDelay: number | null;
  stopOnTime: number | null;
  trips: number;
  deps: number;
  peakMax: number | null;
  peakP90: number | null;
  crowdedDeps: number;
  /** andel av linjens avganger (%) som ikke ble telt i måneden */
  uncountedShare?: number | null;
};

export type PaxLoadDelay = {
  op: PaxOperator | "ALL";
  rush: boolean;
  bucket: string;
  n: number;
  meanDelay: number | null;
  medianWorstStop: number | null;
};

export type PaxMunicipality = {
  op: PaxOperator;
  municipality: string;
  county: string | null;
  boardings: number;
  paxHoursLost: number | null;
  paxDelay: number | null;
};

export type PaxCrowded = {
  op: PaxOperator;
  lineRef: string;
  code: string | null;
  headsign: string | null;
  dayType: string | null;
  time: string | null;
  peak: number | null;
  runs: number | null;
  boardingsPerRun: number | null;
  meanDelay: number | null;
  depKey: string;
};

export type PaxSummary = {
  generatedAt: string;
  source: { name: string; url: string; delayWindow: { min: string; max: string } };
  method: { outlierMin: number; loadBuckets: string[]; rushHours: string };
  operators: PaxOperatorSummary[];
  lines: PaxLineSummary[];
  loadDelay: PaxLoadDelay[];
  municipalities: PaxMunicipality[];
  crowded: PaxCrowded[];
};

/** [stopRef, navn, lat, lon, påstigninger/mnd, avstigninger/mnd, lavt-befolket] */
export type PaxStop = [string, string | null, number | null, number | null, number, number, boolean];

/** Én avgang. Arrayene s/o/l/b/a/d er parallelle, ett element per stopp i rekkefølge. */
export type PaxDeparture = {
  /** stabil avgangsnøkkel (siste ledd av ServiceJourney-id) */
  k: string;
  hs: string | null;
  dt: string | null;
  /** planlagt avgang fra første stopp, «HH:MM» */
  t: string | null;
  runs: number | null;
  /** indekser i PaxLine.stops */
  s: number[];
  /** minutter etter t, per stopp */
  o: (number | null)[];
  /** snitt antall om bord ETTER stoppet, per tur */
  l: (number | null)[];
  b: (number | null)[];
  a: (number | null)[];
  /** snitt ankomstforsinkelse (min) ved stoppet */
  d: (number | null)[];
};

export type PaxLine = {
  lineRef: string;
  op: PaxOperator;
  code: string | null;
  name: string | null;
  mode: string | null;
  month: string | null;
  kpi: Partial<PaxLineSummary>;
  history: [string, number][];
  stops: PaxStop[];
  deps: PaxDeparture[];
  hourly: { dt: string; h: number; n: number; peak: number | null; delay: number | null; bpr: number | null }[];
};

// ---------------------------------------------------------------------------
// Henting
// ---------------------------------------------------------------------------

export function paxLineFile(lineRef: string): string {
  return `${PAX_BASE}/lines/${lineRef.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}

async function fetchJsonOrNull<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  // Vite dev-serveren svarer index.html (200) for filer som ikke finnes.
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok || ct.includes("text/html")) {
    if (ct.includes("text/html")) return null;
    throw new Error(`${res.status} ${url}`);
  }
  return (await res.json()) as T;
}

export function usePaxSummary() {
  return useQuery({
    queryKey: ["pax", "summary"],
    queryFn: () => fetchJsonOrNull<PaxSummary>(`${PAX_BASE}/summary.json`),
    enabled: PAX_ENABLED,
    staleTime: Infinity,
  });
}

/** [stopRef, navn, lat, lon, påstigninger, avstigninger, timer tapt, merket forsinkelse, lavt-befolket] — siste måned */
export type PaxStopRow = [string, string | null, number, number, number, number, number | null, number | null, boolean];

export function usePaxStops(op: PaxOperator | null) {
  return useQuery({
    queryKey: ["pax", "stops", op],
    queryFn: () => fetchJsonOrNull<PaxStopRow[]>(`${PAX_BASE}/stops_${op}.json`),
    enabled: PAX_ENABLED && !!op,
    staleTime: Infinity,
  });
}

export function fetchPaxLine(lineRef: string): Promise<PaxLine | null> {
  return fetchJsonOrNull<PaxLine>(paxLineFile(lineRef));
}

export function usePaxLine(lineRef: string | null | undefined) {
  const covered = PAX_ENABLED && isPaxOperator(lineOperator(lineRef));
  return useQuery({
    queryKey: ["pax", "line", lineRef],
    queryFn: () => fetchPaxLine(lineRef!),
    enabled: covered && !!lineRef,
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------------------
// Avgangsnøkkel og oppslag for et reiselegg
// ---------------------------------------------------------------------------

/**
 * Stabil avgangsnøkkel — SAMME regel som KEY_SQL i passenger_stats.py.
 * KOL/OST/TRO: «KOL:ServiceJourney:1003_251008123066227_1001» → «1001»
 * (midtleddet er datasettversjonen, som bytter flere ganger i måneden).
 * Skyss m.fl.: siste «-»-ledd, som stableSjId() i trip-shared.ts.
 */
export function paxDepKey(sjId: string): string {
  const tail = sjId.split(":").pop() ?? sjId;
  if (tail.includes("_")) return tail.slice(tail.lastIndexOf("_") + 1);
  if (tail.includes("-")) return tail.slice(tail.lastIndexOf("-") + 1);
  return tail;
}

function hhmmToMin(t: string | null | undefined): number | null {
  if (!t || t.length < 5) return null;
  const h = Number(t.slice(0, 2));
  const m = Number(t.slice(3, 5));
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

export type LegLoad = {
  /** høyeste snittbelegg mellom påstigning og avstigning */
  peak: number;
  /** snittbelegg over leggets strekninger */
  avg: number;
  /** antall turer tallet bygger på (månedens turer) */
  runs: number | null;
  /** exact = samme avgang (id); nearby = nærmeste avgang samme dagtype ±6 min */
  match: "exact" | "nearby";
  dep: PaxDeparture;
  month: string | null;
};

/**
 * Finn belegget for et legg. `aimedStart` = planlagt avgangstid fra
 * påstigningsstoppet (Date eller ISO-streng), `dayType` fra computeDayType().
 */
export function legLoad(
  line: PaxLine,
  opts: { sjId?: string | null; fromQuay: string; toQuay: string; aimedStart?: string | Date | null; dayType?: string | null },
): LegLoad | null {
  const stopIdx = new Map(line.stops.map((s, i) => [s[0], i]));
  const fromI = stopIdx.get(opts.fromQuay);
  const toI = stopIdx.get(opts.toQuay);
  if (fromI == null || toI == null) return null;

  const span = (dep: PaxDeparture): [number, number] | null => {
    const a = dep.s.indexOf(fromI);
    if (a < 0) return null;
    const b = dep.s.indexOf(toI, a + 1);
    return b > a ? [a, b] : null;
  };

  let dep: PaxDeparture | undefined;
  let match: LegLoad["match"] = "exact";
  if (opts.sjId) {
    const key = paxDepKey(opts.sjId);
    const same = line.deps.filter((d) => d.k === key && span(d));
    dep = same.find((d) => d.dt === opts.dayType) ?? same[0];
  }
  if (!dep && opts.aimedStart) {
    const when = typeof opts.aimedStart === "string" ? new Date(opts.aimedStart) : opts.aimedStart;
    const target = when.getHours() * 60 + when.getMinutes();
    let best: { d: PaxDeparture; diff: number } | null = null;
    for (const d of line.deps) {
      if (opts.dayType && d.dt !== opts.dayType) continue;
      const sp = span(d);
      if (!sp) continue;
      const t0 = hhmmToMin(d.t);
      const off = d.o[sp[0]];
      if (t0 == null || off == null) continue;
      const at = (t0 + off) % 1440;
      const diff = Math.min(Math.abs(at - target), 1440 - Math.abs(at - target));
      if (diff <= 6 && (!best || diff < best.diff)) best = { d, diff };
    }
    if (best) {
      dep = best.d;
      match = "nearby";
    }
  }
  if (!dep) return null;
  const sp = span(dep)!;
  // Belegget ETTER hvert stopp fra påstigning til stoppet før avstigning
  const seg = dep.l.slice(sp[0], sp[1]).filter((x): x is number => x != null);
  if (seg.length === 0) return null;
  return {
    peak: Math.max(...seg),
    avg: seg.reduce((s, x) => s + x, 0) / seg.length,
    runs: dep.runs,
    match,
    dep,
    month: line.month,
  };
}

// ---------------------------------------------------------------------------
// Beleggsnivå
// ---------------------------------------------------------------------------

export type CrowdLevel = {
  key: "low" | "some" | "busy" | "full" | "multi";
  label: string;
  short: string;
  className: string;
};

/**
 * Terskler tilpasset en vanlig bybuss (~40 sitteplasser, ~80–100 totalt).
 * Tallet er et SNITT over månedens turer — enkeltturer varierer.
 * Over 120 er nesten alltid flere busser på samme avgangs-id (innsatsbusser
 * til skolestart o.l.), ikke én overfylt buss.
 */
export function crowdLevel(load: number | null | undefined): CrowdLevel | null {
  if (load == null || !Number.isFinite(load)) return null;
  if (load > 120)
    return { key: "multi", label: "Trolig flere busser", short: "Flere busser",
      className: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300" };
  if (load >= 60)
    return { key: "full", label: "Ofte fullt", short: "Ofte fullt",
      className: "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300" };
  if (load >= 35)
    return { key: "busy", label: "Ofte ståplass", short: "Ståplass",
      className: "border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300" };
  if (load >= 20)
    return { key: "some", label: "Noen ledige seter", short: "En del folk",
      className: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" };
  return { key: "low", label: "Vanligvis god plass", short: "God plass",
    className: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" };
}

// ---------------------------------------------------------------------------
// Formatering
// ---------------------------------------------------------------------------

const MONTHS_NO = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];

export function formatMonthLong(ym: string | null | undefined): string {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS_NO[m - 1]} ${y}`;
}

export function formatMonthShort(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS_NO[m - 1].slice(0, 3)} ${String(y).slice(2)}`;
}

export function fmtInt(n: number | null | undefined): string {
  return n == null ? "—" : Math.round(n).toLocaleString("nb-NO");
}

export function fmtMin(n: number | null | undefined, digits = 1): string {
  return n == null ? "—" : `${n.toLocaleString("nb-NO", { minimumFractionDigits: digits, maximumFractionDigits: digits })} min`;
}

export const DAY_TYPE_NO: Record<string, string> = {
  weekday: "Hverdag",
  saturday: "Lørdag",
  sunday: "Søndag",
  holiday: "Helligdag",
  may17: "17. mai",
};

/** Et årsverk i Norge ≈ 1 695 timer (37,5 t/uke, fratrukket ferie og helligdager). */
export const HOURS_PER_WORK_YEAR = 1695;
