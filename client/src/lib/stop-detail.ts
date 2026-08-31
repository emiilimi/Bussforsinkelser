// ---------------------------------------------------------------------------
// Ferdigaggregert stoppdetalj fra R2 — datagrunnlaget for Stoppanalyse.
//
// Erstatter fem DuckDB-WASM-spørringer mot parquet med ÉTT filoppslag.
// Målt 2026-08-22 (Kringsjå, «Siste måned»): 43,2 s kaldt mot R2, 4,8 s varmt,
// 3,3 s mot lokale filer — altså ~40 s ren HTTP-rundtur for parquet-metadata
// og kolonnebiter, ikke beregning. Shardfilen er ~42 KB gzippet.
//
// Filene lages av build_stop_detail_shards() i pipeline/aggregate_stats.py.
// Formatet er kompakte arrays; kolonnenavnene ligger i dokumentet (dcols/
// hcols/lcols/lhcols) slik at det er selvbeskrivende.
// ---------------------------------------------------------------------------

import { PARQUET_BASE } from "@/hooks/use-parquet-query";

/** Må være IDENTISK med shard_of() i pipeline/aggregate_stats.py — ellers
 *  leter klienten i feil fil. crc32 (IEEE 802.3, samme polynom som zlib). */
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(s: string): number {
  const bytes = new TextEncoder().encode(s); // UTF-8, som Python .encode()
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Antall shards — MÅ matche STATS_STOP_SHARDS i pipelinen. */
export const STOP_SHARDS = 2000;

export function shardOf(stopPlaceRef: string): number {
  return crc32(stopPlaceRef) % STOP_SHARDS;
}

// --- Dokumentformat (speiler build_stop_detail_shards) ----------------------

/** [dayOffset, avg, max, min, pct2plus, pctEarly, stddev, numDepartures] */
type DailyTuple = [number, number | null, number | null, number | null,
                   number | null, number | null, number | null, number];
/** [hour, avg, maxAvg, minAvg, numSamples] */
type HourTuple = [number, number | null, number | null, number | null, number];
/** [lineRef, avg, numSamples] */
type LineTuple = [string, number | null, number];
/** [lineRef, hour, avg, numSamples] */
type LineHourTuple = [string, number, number | null, number];

type StopEntry = {
  d: DailyTuple[];
  h: Record<string, HourTuple[]>;
  l: Record<string, LineTuple[]>;
  lh: Record<string, LineHourTuple[]>;
  dir: string[];
};

export type ShardDoc = {
  generatedAt: string;
  shard: number;
  windows: number[];
  maxDate: string;
  stops: Record<string, StopEntry>;
};

// Én henting per shard per sesjon. Shardfilene endres nattlig, så no-cache
// (revalider, gjenbruk ved 304) — samme mønster som de andre artefaktene.
const shardCache = new Map<number, Promise<ShardDoc | null>>();

function fetchShard(shard: number): Promise<ShardDoc | null> {
  let p = shardCache.get(shard);
  if (!p) {
    p = fetch(`${PARQUET_BASE}/stops/${shard}.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<ShardDoc>) : null))
      .catch(() => {
        shardCache.delete(shard); // tillat nytt forsøk
        return null;
      });
    shardCache.set(shard, p);
  }
  return p;
}

/**
 * Hent stoppdetaljer for et sett quays.
 *
 * Vanligvis ÉN shard: quayene til ett stoppested hashes på stoppestedet og
 * havner sammen. Enkelte fysiske stopp er delt på flere NSR:StopPlace (Oslo
 * Kringsjå ligger på 6211 OG 6213), og da hentes de shardene som trengs —
 * fortsatt to små filer mot titalls sekunder med parquet-rundturer.
 */
export async function fetchStopDetail(
  quays: Array<{ stopRef: string; stopPlaceRef: string | null }>,
): Promise<{ stops: Map<string, StopEntry>; maxDate: string | null; windows: number[] }> {
  const shards = new Set<number>();
  for (const q of quays) shards.add(shardOf(q.stopPlaceRef || q.stopRef));

  const docs = (await Promise.all(Array.from(shards).map(fetchShard)))
    .filter((d): d is ShardDoc => d != null);

  const stops = new Map<string, StopEntry>();
  const allMaxDates: string[] = [];
  let windows: number[] = [];
  for (const doc of docs) {
    if (doc.maxDate) allMaxDates.push(doc.maxDate);
    if (doc.windows?.length) windows = doc.windows;
    for (const q of quays) {
      const e = doc.stops[q.stopRef];
      if (e) stops.set(q.stopRef, e);
    }
  }
  const maxDate = allMaxDates.length ? allMaxDates.slice().sort().pop()! : null;
  return { stops, maxDate, windows };
}

/** Nærmeste tilgjengelige vindu — artefakten har bare 7/30/90. */
export function snapToWindow(days: number, windows: number[]): number | null {
  if (!windows.length) return null;
  let best = windows[0];
  for (const w of windows) if (Math.abs(w - days) < Math.abs(best - days)) best = w;
  return best;
}

/** dayOffset (0 = maxDate) → ISO-dato. */
export function offsetToDate(maxDate: string, offset: number): string {
  const d = new Date(`${maxDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export type { StopEntry, DailyTuple, HourTuple, LineTuple, LineHourTuple };
