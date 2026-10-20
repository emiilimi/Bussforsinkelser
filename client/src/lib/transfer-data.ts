// ---------------------------------------------------------------------------
// Overgangsfiler fra R2 — reiseplanleggerens statistikk uten DuckDB.
//
// Pipelinen (pipeline/transfer_shards.py) skriver rådata PER PLATTFORM:
// hvilke avganger som passerte, med linje, retning, rutetider og målt
// forsinkelse per dato. Alt reiseplanleggeren ellers spør DuckDB-WASM om —
// overgangs-gap (tre matche-nivåer), persentiler per (stopp, linje) og
// estimert avgang/ankomst — kan regnes ut av dette i nettleseren. En overgang
// er bare to plattformer stilt opp mot hverandre dato for dato.
//
// Hvorfor: DuckDB-veien tok ~30 s varmt og ~80 s kaldt for et vanlig søk
// (én spørring om gangen, HTTP range-kall per stopp × ukefil). Her er det
// ett lite filoppslag per plattform.
//
// Dekning: bare operatørene og datoene index.json oppgir. Alt annet —
// andre operatører, «Siste 90 dager», «Alle hverdager» — går til DuckDB
// som før. Funksjonene under returnerer null når de ikke dekker en forespørsel,
// og kalleren faller da tilbake.
//
// Semantikken speiler SQL-en i trip-shared.ts / trip-planner.tsx. Eneste
// bevisste avvik: oppslag på «eksakt avgangs-id» bruker den STABILE id-en
// (siste «-»-ledd). For operatører uten «-» i id-en (Ruter) er det identisk.
// ---------------------------------------------------------------------------

import { useQuery } from "@tanstack/react-query";
import { PARQUET_BASE, latestDataDate } from "@/hooks/use-parquet-query";
import { crc32 } from "@/lib/stop-detail";
import type { DuckDelayRow, ResolvedStatsWindow, TransferSpec } from "@/lib/trip-shared";

export type TransferIndex = {
  v: number;
  generatedAt: string;
  shards: number;
  path: string;
  operators: string[];
  from: string;
  to: string;
};

/** [lineIdx, direction, stableKey, aimedArrMin, aimedDepMin, offsets, arr, dep]
 *  — arr/dep i hundredels minutter. Se pipeline/transfer_shards.py. */
type Group = [number, string | null, string, number | null, number | null,
              number[], Array<number | null>, Array<number | null>];

type TransferShard = {
  v: number;
  d0: string;
  dt: string;
  L: string[];
  q: Record<string, Group[]>;
};

const FORMAT_VERSION = 1;
const DAY_TYPE: Record<string, string> = {
  W: "weekday", S: "saturday", U: "sunday", H: "holiday", M: "may17",
};

// --- henting ---------------------------------------------------------------

let indexPromise: Promise<TransferIndex | null> | null = null;

export function fetchTransferIndex(): Promise<TransferIndex | null> {
  if (!indexPromise) {
    indexPromise = fetch(`${PARQUET_BASE}/transfer/index.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<TransferIndex>) : null))
      .then((idx) => (idx && idx.v === FORMAT_VERSION && idx.shards > 0 ? idx : null))
      .catch(() => {
        indexPromise = null; // tillat nytt forsøk
        return null;
      });
  }
  return indexPromise;
}

/** Indeksen som React-tilstand (null til den er lest, eller hvis den mangler). */
export function useTransferIndex(): TransferIndex | null {
  const { data } = useQuery({
    queryKey: ["transfer-index"],
    queryFn: fetchTransferIndex,
    staleTime: Infinity,
    retry: false,
  });
  return data ?? null;
}

/** MÅ være lik shard_of() i pipeline/transfer_shards.py. */
export function transferShardOf(quayRef: string, shards: number): number {
  return crc32(quayRef) % shards;
}

/** Siste «-»-ledd av en avgangs-id — samme regel som stableSjId() i
 *  trip-shared.ts (gjentatt her for å unngå sirkulær import). */
function stableTail(sjId: string): string {
  const i = sjId.lastIndexOf("-");
  return i >= 0 ? sjId.slice(i + 1) : sjId;
}

/** MÅ være lik stable_key() i pipeline/transfer_shards.py. */
export function stableKey(sjId: string): string {
  return crc32(stableTail(sjId)).toString(36);
}

const shardCache = new Map<string, Promise<TransferShard | null>>();

function fetchShard(idx: TransferIndex, shard: number): Promise<TransferShard | null> {
  const url = `${PARQUET_BASE}/${idx.path}/${shard}.json?v=${encodeURIComponent(idx.generatedAt)}`;
  let p = shardCache.get(url);
  if (!p) {
    p = fetch(url, { cache: "no-cache" })
      // 404 = ingen avganger for dekkede operatører i den shardet → tom shard
      .then((r) => (r.ok ? (r.json() as Promise<TransferShard>) : r.status === 404 ? emptyShard() : null))
      .catch(() => {
        shardCache.delete(url);
        return null;
      });
    shardCache.set(url, p);
  }
  return p;
}

function emptyShard(): TransferShard {
  return { v: FORMAT_VERSION, d0: "1970-01-01", dt: "", L: [], q: {} };
}

type QuayData = { shard: TransferShard; groups: Group[] };

/** Hent dataene for et sett plattformer. null = minst én shard feilet. */
async function loadQuays(idx: TransferIndex, quays: string[]): Promise<Map<string, QuayData> | null> {
  const want = new Map<number, string[]>();
  for (const q of quays) {
    const s = transferShardOf(q, idx.shards);
    want.set(s, [...(want.get(s) ?? []), q]);
  }
  const out = new Map<string, QuayData>();
  const entries = Array.from(want.entries());
  const docs = await Promise.all(entries.map(([s]) => fetchShard(idx, s)));
  for (let i = 0; i < entries.length; i++) {
    const doc = docs[i];
    if (!doc) return null;
    for (const q of entries[i][1]) out.set(q, { shard: doc, groups: doc.q[q] ?? [] });
  }
  return out;
}

// --- dekning ---------------------------------------------------------------

function operatorOf(lineRef: string): string {
  return lineRef.split(":")[0];
}

/**
 * Dekker filene dette vinduet og disse linjene? Vinduet må ha en startdato
 * innenfor filenes periode (standardvinduet «samme dagtype, siste 30 dager»
 * og «Siste 7/30 dager» gjør det; «Alle hverdager» og «Siste 90 dager» ikke).
 * `latest` er siste datadag i parquet: er filene eldre enn den (pipelinen
 * feilet halvveis), brukes DuckDB så ingen dager faller stille ut.
 */
export function transferCovers(
  idx: TransferIndex | null,
  window: ResolvedStatsWindow | undefined,
  lineRefs: Array<string | null | undefined>,
  latest?: string | null,
): boolean {
  if (!idx || !window || !window.dateFrom) return false;
  if (window.dateFrom < idx.from) return false;
  // Uten eksplisitt dato: siste datadag fra parquet-manifestet, hvis lest.
  const newest = latest === undefined ? latestDataDate("by-stop") : latest;
  if (newest && newest > idx.to) return false;
  for (const l of lineRefs) {
    if (!l || !idx.operators.includes(operatorOf(l))) return false;
  }
  return true;
}

// --- vindu -----------------------------------------------------------------

/** Hvilke dagforskyvninger i en shard som er med i vinduet. */
function allowedOffsets(shard: TransferShard, w: ResolvedStatsWindow): { ok: boolean[]; dates: string[] } {
  const ok: boolean[] = [];
  const dates: string[] = [];
  const base = new Date(`${shard.d0}T00:00:00Z`);
  for (let i = 0; i < shard.dt.length; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    dates.push(iso);
    const dt = DAY_TYPE[shard.dt[i]];
    ok.push(
      dt !== undefined &&
      (!w.dayTypes || w.dayTypes.length === 0 || w.dayTypes.includes(dt)) &&
      (!w.dateFrom || iso >= w.dateFrom) &&
      (!w.dateTo || iso <= w.dateTo),
    );
  }
  return { ok, dates };
}

/** PERCENTILE_CONT som i DuckDB: lineær interpolasjon på sorterte verdier. */
function percentileCont(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// --- overgangs-gap ---------------------------------------------------------

/** Samme form som radene fra computeTransferGap sin DuckDB-spørring. */
export type LocalGapRow = {
  src: "S" | "A" | "P";
  date: string;
  gap: number;
  arr_min: number | null;
  dep_min: number | null;
};

type Side = "arr" | "dep";

/** Én observasjon på én side av overgangen. */
type SideObs = { off: number; aimed: number; delay: number };

function sideObs(
  qd: QuayData,
  side: Side,
  ok: boolean[],
  match: (g: Group, line: string) => boolean,
): SideObs[] {
  const out: SideObs[] = [];
  for (const g of qd.groups) {
    if (!match(g, qd.shard.L[g[0]])) continue;
    const aimed = side === "arr" ? g[3] : g[4];
    if (aimed == null) continue;
    const vals = side === "arr" ? g[6] : g[7];
    const offs = g[5];
    for (let i = 0; i < offs.length; i++) {
      const v = vals[i];
      if (v == null || !ok[offs[i]]) continue;
      out.push({ off: offs[i], aimed, delay: v / 100 });
    }
  }
  return out;
}

/** dirClause(): retningen den planlagte avgangen selv har på plattformen.
 *  undefined = ukjent → ingen retningsfilter (som COALESCE i SQL-en). */
function directionOf(qd: QuayData, sjId: string | null): string | undefined {
  if (!sjId) return undefined;
  const key = stableKey(sjId);
  for (const g of qd.groups) if (g[2] === key && g[1] != null) return g[1];
  return undefined;
}

function midnightSafe(x: number): number {
  return x < -720 ? x + 1440 : x;
}

/** Ankomst × avgang samme dato (indre join på dato). */
function joinByDate(arr: SideObs[], dep: SideObs[]): Array<[SideObs, SideObs]> {
  const byOff = new Map<number, SideObs[]>();
  for (const d of dep) byOff.set(d.off, [...(byOff.get(d.off) ?? []), d]);
  const out: Array<[SideObs, SideObs]> = [];
  for (const a of arr) for (const d of byOff.get(a.off) ?? []) out.push([a, d]);
  return out;
}

/** Per dato: observasjonen med rutetid nærmest målet (QUALIFY ROW_NUMBER i
 *  poolGapSql). Uavgjort (08:33 og 08:43 mot 08:38) → TIDLIGSTE rutetid, så
 *  svaret er det samme hver gang. DuckDB-varianten velger vilkårlig ved
 *  uavgjort (ORDER BY ABS(...) alene) og kan gi ulikt svar fra kjøring til
 *  kjøring — målt i paritetssjekken 2026-10-10. */
function nearestPerDate(obs: SideObs[], target: number): SideObs[] {
  const best = new Map<number, SideObs>();
  for (const o of obs) {
    const cur = best.get(o.off);
    const dO = Math.abs(o.aimed - target);
    const dC = cur ? Math.abs(cur.aimed - target) : Infinity;
    if (dO < dC || (dO === dC && cur && o.aimed < cur.aimed)) best.set(o.off, o);
  }
  return Array.from(best.values());
}

/**
 * Alle tre matche-nivåene for én overgang, som rader i samme form som
 * DuckDB-spørringen i computeTransferGap. null = ikke dekket / feilet.
 */
export async function localTransferGapRows(
  s: TransferSpec,
  latest?: string | null,
): Promise<LocalGapRow[] | null> {
  const idx = await fetchTransferIndex();
  if (!s.arrQuayRef || !s.depQuayRef) return null;
  if (!transferCovers(idx, s.statsWindow, [s.arrLineRef, s.depLineRef], latest)) return null;
  const data = await loadQuays(idx!, [s.arrQuayRef, s.depQuayRef]);
  if (!data) return null;
  const A = data.get(s.arrQuayRef)!;
  const D = data.get(s.depQuayRef)!;
  const { ok: okA, dates: datesA } = allowedOffsets(A.shard, s.statsWindow!);
  const { ok: okD } = allowedOffsets(D.shard, s.statsWindow!);
  // To shards kan i en overgangsnatt ha ulik d0 — still dem opp på dato.
  const shiftD = A.shard.d0 === D.shard.d0 ? 0 :
    Math.round((Date.parse(D.shard.d0) - Date.parse(A.shard.d0)) / 86_400_000);
  const toA = (o: SideObs): SideObs => (shiftD ? { ...o, off: o.off + shiftD } : o);

  const rows: LocalGapRow[] = [];

  // Nivå 1 — stabil avgangs-id (sjGapSql). Ingen linje- eller retningsfilter.
  if (s.arrSjId && s.depSjId) {
    const ka = stableKey(s.arrSjId);
    const kd = stableKey(s.depSjId);
    const arr = sideObs(A, "arr", okA, (g) => g[2] === ka);
    const dep = sideObs(D, "dep", okD, (g) => g[2] === kd).map(toA);
    for (const [a, d] of joinByDate(arr, dep)) {
      const am = a.aimed + a.delay;
      const dm = d.aimed + d.delay;
      rows.push({ src: "S", date: datesA[a.off], gap: midnightSafe(dm - am), arr_min: am, dep_min: dm });
    }
  }

  if (s.arrLineRef && s.depLineRef && s.arrAimedMin != null && s.depAimedMin != null) {
    const dirA = directionOf(A, s.arrSjId);
    const dirD = directionOf(D, s.depSjId);
    const lineDirA = (g: Group, line: string) => line === s.arrLineRef && (dirA === undefined || g[1] === dirA);
    const lineDirD = (g: Group, line: string) => line === s.depLineRef && (dirD === undefined || g[1] === dirD);

    // Nivå 2 — eksakt rutetid + linje + retning (aimedGapSql)
    const arrA = sideObs(A, "arr", okA, (g, l) => lineDirA(g, l) && g[3] === s.arrAimedMin);
    const depA = sideObs(D, "dep", okD, (g, l) => lineDirD(g, l) && g[4] === s.depAimedMin).map(toA);
    for (const [a, d] of joinByDate(arrA, depA)) {
      const am = a.aimed + a.delay;
      const dm = d.aimed + d.delay;
      rows.push({ src: "A", date: datesA[a.off], gap: midnightSafe(dm - am), arr_min: am, dep_min: dm });
    }

    // Nivå 3 — ±60 min-pool, bare forsinkelsen er overførbar (poolGapSql)
    const HALF = 60;
    let planned = s.depAimedMin - s.arrAimedMin;
    if (planned < -720) planned += 1440;
    const arrP = nearestPerDate(
      sideObs(A, "arr", okA, (g, l) => lineDirA(g, l) && g[3] != null && Math.abs(g[3] - s.arrAimedMin!) <= HALF),
      s.arrAimedMin);
    const depP = nearestPerDate(
      sideObs(D, "dep", okD, (g, l) => lineDirD(g, l) && g[4] != null && Math.abs(g[4] - s.depAimedMin!) <= HALF),
      s.depAimedMin).map(toA);
    for (const [a, d] of joinByDate(arrP, depP)) {
      rows.push({ src: "P", date: datesA[a.off], gap: planned + d.delay - a.delay, arr_min: null, dep_min: null });
    }
  }
  return rows;
}

// --- persentiler per (stopp, linje) ---------------------------------------

/** Samme tall som useTripDelayDistribution sin DuckDB-spørring. null = ikke dekket. */
export async function localDelayDistribution(
  pairs: Array<{ stopRef: string; lineRef: string }>,
  window: ResolvedStatsWindow,
  latest?: string | null,
): Promise<Map<string, DuckDelayRow> | null> {
  const idx = await fetchTransferIndex();
  if (!transferCovers(idx, window, pairs.map((p) => p.lineRef), latest)) return null;
  const data = await loadQuays(idx!, Array.from(new Set(pairs.map((p) => p.stopRef))));
  if (!data) return null;
  const out = new Map<string, DuckDelayRow>();
  for (const p of pairs) {
    const qd = data.get(p.stopRef)!;
    const { ok } = allowedOffsets(qd.shard, window);
    const arr: number[] = [];
    const dep: number[] = [];
    let n = 0;
    for (const g of qd.groups) {
      if (qd.shard.L[g[0]] !== p.lineRef) continue;
      for (let i = 0; i < g[5].length; i++) {
        if (!ok[g[5][i]]) continue;
        const a = g[6][i];
        const d = g[7][i];
        if (a == null && d == null) continue;
        n++;
        if (a != null) arr.push(a / 100);
        if (d != null) dep.push(d / 100);
      }
    }
    if (n === 0) continue; // GROUP BY ga ingen rad for paret
    arr.sort((x, y) => x - y);
    dep.sort((x, y) => x - y);
    out.set(`${p.stopRef}|${p.lineRef}`, {
      stop_ref: p.stopRef,
      line_ref: p.lineRef,
      p50_dep: percentileCont(dep, 0.5),
      p80_dep: percentileCont(dep, 0.8),
      p95_dep: percentileCont(dep, 0.95),
      p50_arr: percentileCont(arr, 0.5),
      p80_arr: percentileCont(arr, 0.8),
      p95_arr: percentileCont(arr, 0.95),
      n,
    });
  }
  return out;
}

// --- estimert avgang/ankomst per legg --------------------------------------

export type LocalLegTimingSpec = {
  serviceJourneyId: string;
  quayRef: string;
  lineRef: string;
  kind: "dep" | "arr";
  aimedHour: number;
  window: ResolvedStatsWindow;
};

/**
 * Samme som legTimingSql i trip-planner.tsx: delta = undefined → samme avgang,
 * ellers linje + plattform med rutetid innenfor ±delta timer.
 * null = ikke dekket.
 */
export async function localLegTiming(
  s: LocalLegTimingSpec,
  delta: number | undefined,
  latest?: string | null,
): Promise<{ p50: number | null; p80: number | null; n: number } | null> {
  const idx = await fetchTransferIndex();
  if (!transferCovers(idx, s.window, [s.lineRef], latest)) return null;
  const data = await loadQuays(idx!, [s.quayRef]);
  if (!data) return null;
  const qd = data.get(s.quayRef)!;
  const { ok } = allowedOffsets(qd.shard, s.window);
  const key = stableKey(s.serviceJourneyId);
  const vals: number[] = [];
  for (const g of qd.groups) {
    if (delta == null) {
      if (g[2] !== key) continue;
    } else {
      if (qd.shard.L[g[0]] !== s.lineRef) continue;
      const aimed = s.kind === "dep" ? g[4] : g[3];
      if (aimed == null) continue;
      const h = Math.floor(aimed / 60);
      if (h < s.aimedHour - delta || h > s.aimedHour + delta) continue;
    }
    const col = s.kind === "dep" ? g[7] : g[6];
    for (let i = 0; i < g[5].length; i++) {
      const v = col[i];
      if (v != null && ok[g[5][i]]) vals.push(v / 100);
    }
  }
  vals.sort((x, y) => x - y);
  return { p50: percentileCont(vals, 0.5), p80: percentileCont(vals, 0.8), n: vals.length };
}
