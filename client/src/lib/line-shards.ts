// ---------------------------------------------------------------------------
// Linjefiler fra R2 — Linjeanalysens /distribution uten DuckDB (2026-11-25).
//
// pipeline/line_shards.py kjører apiLineDistribution-spørringen for ALLE
// linjer i standardvisningen (siste 30 dager, begge retninger, alle dagtyper)
// og skriver svaret kompakt per linje. Her pakkes det ut til de samme
// DistRow-radene som DuckDB ville gitt, slik at parseDistribution er uendret.
//
// Hvorfor: én DuckDB-spørring for linje 3 tok > 90 s kaldt (målt lokalt mot
// R2) og blokkerte fordeling, varmekart, timesprofil og dagstrend.
//
// Dekning: bare når forespørselen er nøyaktig standardvisningen OG filene er
// bygget fra samme siste datadag som manifestet. Ellers null → DuckDB som før.
// ---------------------------------------------------------------------------

import { PARQUET_BASE } from "@/hooks/use-parquet-query";
import { crc32 } from "@/lib/stop-detail";
import type { DistRow } from "@/lib/line-distribution";

const LINES_BASE =
  (import.meta as any).env?.VITE_LINES_BASE_URL?.trim().replace(/\/+$/, "") || `${PARQUET_BASE}/lines`;

const FORMAT_VERSION = 1;

export type LineIndex = { v: number; generatedAt: string; from: string; to: string; days: number; shards: number };

/** Kompakt form per linje — se docstringen i pipeline/line_shards.py. */
type Packed = {
  c: Array<[number, number, number, number, number, number, number[]]>;
  d: Array<[number, number, number, number, number, number, number | null, number | null, number | null]>;
  o: [number, number, number, number, number, number | null, number | null, number | null, number | null, number | null] | null;
  h: Array<[number, number, number, number, number | null, number | null]>;
};
type LineShard = { v: number; from: string; to: string; lines: Record<string, Packed> };

/** MÅ være lik line_shard_of() i pipeline/line_shards.py. */
export function lineShardOf(lineRef: string, shards: number): number {
  return crc32(lineRef) % shards;
}

let indexPromise: Promise<LineIndex | null> | null = null;
function fetchLineIndex(): Promise<LineIndex | null> {
  if (!indexPromise) {
    indexPromise = fetch(`${LINES_BASE}/index.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: LineIndex | null) => (j && j.v === FORMAT_VERSION ? j : null))
      .catch(() => null);
  }
  return indexPromise;
}

let latestPromise: Promise<string | null> | null = null;
/** Siste datadag i by-line-familien, rett fra manifestet — uten å starte DuckDB. */
function manifestLatestByLine(): Promise<string | null> {
  if (!latestPromise) {
    const url = PARQUET_BASE.includes("/api/parquet") ? `${PARQUET_BASE}/manifest` : `${PARQUET_BASE}/manifest.json`;
    latestPromise = fetch(url, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((entries: Array<string | { name: string; maxDate?: string }> | null) => {
        let max: string | null = null;
        for (const e of entries ?? []) {
          if (typeof e === "string" || !e.name.endsWith("-by-line.parquet") || !e.maxDate) continue;
          if (max === null || e.maxDate > max) max = e.maxDate;
        }
        return max;
      })
      .catch(() => null);
  }
  return latestPromise;
}

const shardCache = new Map<string, Promise<LineShard | null>>();
function fetchShard(idx: LineIndex, shard: number): Promise<LineShard | null> {
  const url = `${LINES_BASE}/${shard}.json?v=${encodeURIComponent(idx.generatedAt)}`;
  let p = shardCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    shardCache.set(url, p);
  }
  return p;
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Packed → samme DistRow[] som apiLineDistribution-SQL-en. */
export function unpackLine(p: Packed, from: string): DistRow[] {
  const rows: DistRow[] = [];
  const base = { date: null, dow: null, hour: null, b: null, p50: null, p80: null, p95: null, sd: null, deps: null };
  // Kind 0: summene per celle legges på cellens første bøtte, resten får bare
  // n — parseDistribution summerer per celle, så resultatet blir det samme.
  for (const [k, n, s, early, punctual, late10, bins] of p.c) {
    const dow = Math.floor(k / 24);
    const hour = k % 24;
    for (let i = 0; i < bins.length; i += 2) {
      const first = i === 0;
      rows.push({
        ...base, kind: 0, dow, hour, b: bins[i], n: bins[i + 1],
        s: first ? s : 0, early: first ? early : 0, punctual: first ? punctual : 0, late10: first ? late10 : 0,
      });
    }
    void n;
  }
  for (const [off, n, s, early, punctual, late10, p50, p80, deps] of p.d) {
    rows.push({ ...base, kind: 1, date: addDays(from, off), n, s, early, punctual, late10, p50, p80, deps });
  }
  if (p.o) {
    const [n, s, early, punctual, late10, p50, p80, p95, sd, deps] = p.o;
    rows.push({ ...base, kind: 2, n, s, early, punctual, late10, p50, p80, p95, sd, deps });
  }
  for (const [off, hour, n, s, min, max] of p.h) {
    rows.push({ ...base, kind: 3, date: addDays(from, off), hour, n, s, early: 0, punctual: 0, late10: 0, p50: min, p80: max });
  }
  return rows;
}

/**
 * /distribution for en linje fra linjefilene, eller null når de ikke dekker
 * forespørselen (filter, annet vindu, utdaterte filer, linje uten data) —
 * kalleren bruker da DuckDB.
 */
export async function lineDistributionFromShards(lineRef: string, params: URLSearchParams): Promise<DistRow[] | null> {
  // Dagtypefilteret sjekker kalleren (dayTypeClause i stats-adapter.ts).
  if (params.get("from") || params.get("to") || params.get("direction")) return null;
  const days = params.get("days") ? parseInt(params.get("days")!, 10) : 30;
  const [idx, latest] = await Promise.all([fetchLineIndex(), manifestLatestByLine()]);
  if (!idx || !latest || idx.days !== days || idx.to !== latest) return null;
  if (idx.from !== addDays(latest, -(days - 1))) return null;
  const shard = await fetchShard(idx, lineShardOf(lineRef, idx.shards));
  if (!shard || shard.v !== FORMAT_VERSION || shard.from !== idx.from || shard.to !== idx.to) return null;
  const p = shard.lines[lineRef];
  return p ? unpackLine(p, shard.from) : null;
}
