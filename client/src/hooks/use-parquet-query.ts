import { useState, useEffect, useCallback, useRef } from "react";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { useDuckDB, initDuckDB, warmupDuckDB } from "./use-duckdb";

// ---------------------------------------------------------------------------
// Base URL for Parquet files — falls back to local server during development.
// In production, point VITE_PARQUET_BASE_URL at Cloudflare R2 public URL.
// Eksportert: stats-adapteren henter artefaktene (stats_*.json) fra samme base.
// ---------------------------------------------------------------------------

export const PARQUET_BASE =
  (import.meta as any).env?.VITE_PARQUET_BASE_URL?.replace(/\/$/, "") ??
  `${typeof window !== "undefined" ? window.location.origin : ""}/api/parquet`;

// ---------------------------------------------------------------------------
// To filfamilier per uke — samme rader, ulik fysisk sortering (se
// pipeline/export_parquet.py). Radgruppe-statistikk (min/max) lar DuckDB
// hoppe over hele radgrupper, men bare langs kolonnen filen er sortert på —
// derfor to familier: linje-sider bruker "by-line", stopp-sider "by-stop".
// Målt: riktig familie henter ~0.3 MB i 4-5 HTTP-kall per uke for en typisk
// spørring, mot ~9-12 MB i 23 kall for en usortert fil.
// ---------------------------------------------------------------------------

export type DelayFamily = "by-line" | "by-stop";
const FAMILIES: DelayFamily[] = ["by-line", "by-stop"];
// Familie brukt for spørringer som skanner alt uansett (leaderboards, kart)
// og som ikke oppgir en familie eksplisitt — begge er like riktige/trege der.
const DEFAULT_FAMILY: DelayFamily = "by-stop";

// ---------------------------------------------------------------------------
// Track which Parquet files have been registered in DuckDB
// ---------------------------------------------------------------------------

// Manifest entries: plain filename (local Express) or { name, md5 } (R2).
// md5 brukes som cache-buster: ukefiler overskrives daglig med samme navn,
// så uten ?v=md5 kan nettleseren servere gårsdagens bytes fra HTTP-cache.
type ManifestEntry = string | { name: string; md5?: string };

type RegisteredFile = { url: string; family: DelayFamily; week: string; fromIso: string; toIso: string };

// name → registered file info (both families share this map)
const registeredFiles = new Map<string, RegisteredFile>();

// Throttle manifest re-checks: ensureFilesRegistered kalles per query, men
// manifestet trenger bare sjekkes med jevne mellomrom.
const MANIFEST_CHECK_INTERVAL_MS = 60_000;
let lastManifestCheck = 0;

/** "2026-W29-by-line.parquet" -> { week: "2026-W29", family: "by-line" }. null hvis ikke gjenkjent. */
function parseFileName(name: string): { week: string; family: DelayFamily } | null {
  const stem = name.replace(/\.parquet$/, "");
  for (const family of FAMILIES) {
    if (stem.endsWith(`-${family}`)) {
      return { week: stem.slice(0, -(family.length + 1)), family };
    }
  }
  return null;
}

/** ISO week string ("2026-W29") -> [monday, sunday] as YYYY-MM-DD. */
function weekDateRange(week: string): [string, string] {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return ["0000-01-01", "9999-12-31"];
  const year = Number(m[1]);
  const weekNum = Number(m[2]);
  // ISO 8601: week 1 is the week containing the first Thursday of the year.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (weekNum - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return [iso(monday), iso(sunday)];
}

async function ensureFilesRegistered(db: AsyncDuckDB): Promise<void> {
  if (
    registeredFiles.size > 0 &&
    Date.now() - lastManifestCheck < MANIFEST_CHECK_INTERVAL_MS
  ) {
    return;
  }
  lastManifestCheck = Date.now();
  // Fetch manifest — from R2 (manifest.json) or from local server
  const manifestUrl = PARQUET_BASE.includes("/api/parquet")
    ? `${PARQUET_BASE}/manifest`      // local Express endpoint returns JSON array
    : `${PARQUET_BASE}/manifest.json`; // R2 serves a static JSON file

  // no-cache: alltid revalider (ETag/304), men gjenbruk cachet svar når
  // uendret. Manifestet er nøkkelen
  // som forteller oss om parquet-innholdet har endret seg.
  const res = await fetch(manifestUrl, { cache: "no-cache" });
  if (!res.ok) return;

  const entries: ManifestEntry[] = await res.json();
  if (!entries || entries.length === 0) return;

  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name;
    const md5 = typeof entry === "string" ? undefined : entry.md5;
    const parsed = parseFileName(name);
    if (!parsed) continue; // ukjent/gammelt filnavn-format — ignorer
    const url = md5
      ? `${PARQUET_BASE}/${name}?v=${md5}`
      : `${PARQUET_BASE}/${name}`;

    if (registeredFiles.get(name)?.url === url) continue;

    // Re-register if the file content changed mid-session (new md5)
    if (registeredFiles.has(name)) {
      try {
        await db.dropFile(name);
      } catch {
        // ignore — file may not have been buffered
      }
    }
    const [fromIso, toIso] = weekDateRange(parsed.week);
    // Full absolute URL — DuckDB worker runs from a blob: origin and
    // cannot resolve relative paths.
    await db.registerFileURL(name, url, 4 /* DuckDBDataProtocol.HTTP */, false);
    registeredFiles.set(name, { url, family: parsed.family, week: parsed.week, fromIso, toIso });
  }
}

/** Sikrer at manifestet er lest og filene registrert — kall før
 *  latestAvailableDate() slik at den ikke leser et tomt kart. */
export async function ensureParquetFilesRegistered(): Promise<void> {
  const db = await initDuckDB();
  await ensureFilesRegistered(db);
}

/** Seneste dato dekket av en registrert ukefil i gitt familie (siste dag i
 *  ISO-ukens søndag — en øvre tilnærming, aldri for lav). Brukes til å regne
 *  "N dager tilbake fra ferskeste tilgjengelige data" i JS uten en egen
 *  DuckDB-spørring (erstatter det tidligere MAX(date)-underspørringsmønsteret
 *  mot den nå fjernede generiske "delays"-viewen). */
export function latestAvailableDate(family: DelayFamily = DEFAULT_FAMILY): string | null {
  let max: string | null = null;
  for (const f of Array.from(registeredFiles.values())) {
    if (f.family !== family) continue;
    if (max === null || f.toIso > max) max = f.toIso;
  }
  return max;
}

/** Filer for én familie, ev. begrenset til uker som overlapper [fromDate, toDate]. */
function filesForFamily(family: DelayFamily, fromDate?: string, toDate?: string): string[] {
  const out: string[] = [];
  for (const [name, f] of Array.from(registeredFiles.entries())) {
    if (f.family !== family) continue;
    if (fromDate && f.toIso < fromDate) continue;
    if (toDate && f.fromIso > toDate) continue;
    out.push(f.url);
  }
  return out;
}

/** (Re)oppretter delays_by_line / delays_by_stop-viewene, ev. begrenset til
 *  et datointervall — DuckDB slipper da å i det hele tatt åpne ukefiler
 *  utenfor vinduet (ikke bare hoppe over radgrupper i dem). Billig
 *  metadata-operasjon, kjøres på nytt per spørring som oppgir et intervall. */
async function prepareView(
  conn: AsyncDuckDBConnection,
  family: DelayFamily,
  fromDate?: string,
  toDate?: string,
): Promise<string> {
  const viewName = `delays_${family.replace("-", "_")}`;
  const files = filesForFamily(family, fromDate, toDate);
  if (files.length === 0) {
    // Ingen registrerte uker overlapper vinduet — tom, men gyldig, view.
    await conn.query(`CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_parquet([]) WHERE 1=0`);
    return viewName;
  }
  const fileList = files.map((u) => `'${u}'`).join(", ");
  await conn.query(`CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_parquet([${fileList}])`);
  return viewName;
}

// ---------------------------------------------------------------------------
// Delt spørringskjøring: SQL → rader som plain JS-objekter
// ---------------------------------------------------------------------------

async function runQueryOnConn<T = Record<string, unknown>>(
  conn: AsyncDuckDBConnection,
  sql: string,
): Promise<T[]> {
  const result = await conn.query(sql);
  const rows: T[] = [];
  const schema = result.schema.fields;
  for (let i = 0; i < result.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const field of schema) {
      const col = result.getChild(field.name);
      const val = col?.get(i) ?? null;
      // DuckDB returns COUNT(*) etc. as BigInt — convert to Number
      row[field.name] = typeof val === "bigint" ? Number(val) : val;
    }
    rows.push(row as T);
  }
  return rows;
}

export interface QueryOptions {
  /** Hvilken sortert filfamilie spørringen skal kjøre mot — velg ut fra
   *  spørringens primære WHERE-kolonne: "by-line" for line_ref-filtre,
   *  "by-stop" for stop_ref-filtre. Default "by-stop" (vilkårlig — brukes
   *  av spørringer som skanner alt uansett, f.eks. topplister/kart). SQL-en
   *  må referere til viewet ved navn: delays_by_line / delays_by_stop. */
  family?: DelayFamily;
  /** Datointervall (inklusiv) — begrenser hvilke ukefiler som registreres i
   *  viewet, slik at uker utenfor vinduet ikke en gang åpnes. Utelates for
   *  spørringer som trenger hele historikken (topplister, kart). */
  fromDate?: string;
  toDate?: string;
}

/** Erstatter ? med escapede parameterverdier — DuckDB-WASM sitt JS-API
 *  støtter ikke native prepared-statement-binding via conn.query(). */
function bindParams(sql: string, params?: unknown[]): string {
  if (!params || params.length === 0) return sql;
  let idx = 0;
  return sql.replace(/\?/g, () => {
    if (idx >= params.length) return "NULL";
    const val = params[idx++];
    if (val === null || val === undefined) return "NULL";
    if (typeof val === "number" || typeof val === "bigint") return String(val);
    if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}

/**
 * Kjør en DuckDB-spørring utenfor React (brukes av stats-adapteren i
 * queryClient). Initialiserer DuckDB-singletonen og registrerer parquet-filene
 * ved behov — samme instans og views som hooken bruker.
 */
export async function standaloneDuckQuery<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
  options?: QueryOptions,
): Promise<T[]> {
  const db = await initDuckDB();
  await ensureFilesRegistered(db);
  if (registeredFiles.size === 0) {
    throw new Error("Ingen parquet-filer tilgjengelig");
  }
  const conn = await db.connect();
  try {
    await prepareView(conn, options?.family ?? DEFAULT_FAMILY, options?.fromDate, options?.toDate);
    return await runQueryOnConn<T>(conn, bindParams(sql, params));
  } finally {
    await conn.close();
  }
}

// ---------------------------------------------------------------------------
// Hook: useParquetQuery
// ---------------------------------------------------------------------------

export interface ParquetQueryState {
  /** Whether Parquet files are being loaded / DuckDB is initializing */
  loading: boolean;
  /** DuckDB er ikke startet ennå — kall warmupDuckDB() når brukeren gjør
   *  noe som kommer til å trenge den (velger stopp, starter søk). */
  idle: boolean;
  /** Error message if something went wrong */
  error: string | null;
  /** Whether any Parquet files are available */
  ready: boolean;
  /** Run an arbitrary SQL query against loaded Parquet data.
   *  Supports ? parameter binding (replaced sequentially). SQL must
   *  reference delays_by_line / delays_by_stop — pick via options.family. */
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: QueryOptions,
  ) => Promise<T[]>;
  /** Manuelt nytt forsøk på fil-registrering etter at automatiske retries
   *  er brukt opp. Trengs kun ved lengre utilgjengelighet enn ~17s. */
  retry: () => void;
}

// Et enkelt mislykket forsøk (forbigående nettverksglipp, treg R2-edge ved
// kaldstart) skal ikke låse siden permanent i "utilgjengelig" resten av
// økten — uten dette var det ingen vei tilbake før en full sideoppfriskning
// (sett i produksjon: demo hos en venn hang seg opp etter én glipp).
const REGISTRATION_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export function useParquetQuery(): ParquetQueryState {
  const { db, loading: dbLoading, idle: dbIdle, error: dbError } = useDuckDB();
  // Registrering pågår fra db er klar til filene er registrert
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const initDone = useRef(false);
  // Økes av retry() for å tvinge effekten under til å kjøre igjen selv om
  // `db` ikke har endret seg (DuckDB-instansen lever videre — det er
  // fil-registreringen som feilet, ikke selve WASM-initialiseringen).
  const [retryTick, setRetryTick] = useState(0);

  // Register Parquet files once DuckDB is ready — med automatisk retry ved
  // forbigående feil, inntil REGISTRATION_RETRY_DELAYS_MS er brukt opp.
  useEffect(() => {
    if (!db || initDone.current) return;

    let cancelled = false;
    setRegistering(true);
    setError(null);

    (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await ensureFilesRegistered(db);
          if (!cancelled) {
            setReady(registeredFiles.size > 0);
            setRegistering(false);
            setError(null);
          }
          initDone.current = true;
          return;
        } catch (err: unknown) {
          const delay = REGISTRATION_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || cancelled) {
            if (!cancelled) {
              const msg =
                err instanceof Error ? err.message : "Failed to load Parquet files";
              setError(msg);
              setRegistering(false);
            }
            initDone.current = true;
            return;
          }
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db, retryTick]);

  /** Manuelt nytt forsøk etter at automatiske retries er brukt opp (f.eks.
   *  en lengre utilgjengelighet enn ~17s). Dekker begge feilpunkter: hvis
   *  DuckDB-WASM selv ikke kom i gang (db er fortsatt null), start den på
   *  nytt også — warmupDuckDB() er trygg å kalle igjen etter en feilet init
   *  (den nullstiller initPromise/initError selv). */
  const retry = useCallback(() => {
    initDone.current = false;
    setError(null);
    if (!db) warmupDuckDB();
    setRetryTick((t) => t + 1);
  }, [db]);

  // Propagate DuckDB-level errors
  useEffect(() => {
    if (dbError) {
      setError(dbError);
      setRegistering(false);
    }
  }, [dbError]);

  const queryFn = useCallback(
    async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
      options?: QueryOptions,
    ): Promise<T[]> => {
      if (!db) throw new Error("DuckDB not initialized");

      // Re-register files in case new weeks appeared since last check
      await ensureFilesRegistered(db);

      const conn = await db.connect();
      try {
        await prepareView(conn, options?.family ?? DEFAULT_FAMILY, options?.fromDate, options?.toDate);
        return await runQueryOnConn<T>(conn, bindParams(sql, params));
      } finally {
        await conn.close();
      }
    },
    [db],
  );

  return {
    loading: dbLoading || registering,
    idle: dbIdle,
    error,
    ready,
    query: queryFn,
    retry,
  };
}
