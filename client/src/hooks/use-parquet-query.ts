import { useState, useEffect, useCallback, useRef } from "react";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { useDuckDB, initDuckDB } from "./use-duckdb";

// ---------------------------------------------------------------------------
// Base URL for Parquet files — falls back to local server during development.
// In production, point VITE_PARQUET_BASE_URL at Cloudflare R2 public URL.
// Eksportert: stats-adapteren henter artefaktene (stats_*.json) fra samme base.
// ---------------------------------------------------------------------------

export const PARQUET_BASE =
  (import.meta as any).env?.VITE_PARQUET_BASE_URL?.replace(/\/$/, "") ??
  `${typeof window !== "undefined" ? window.location.origin : ""}/api/parquet`;

// ---------------------------------------------------------------------------
// Track which Parquet files have been registered in DuckDB
// ---------------------------------------------------------------------------

// Manifest entries: plain filename (local Express) or { name, md5 } (R2).
// md5 brukes som cache-buster: ukefiler overskrives daglig med samme navn,
// så uten ?v=md5 kan nettleseren servere gårsdagens bytes fra HTTP-cache.
type ManifestEntry = string | { name: string; md5?: string };

// name → versioned URL currently registered in DuckDB
const registeredFiles = new Map<string, string>();

// Throttle manifest re-checks: ensureFilesRegistered kalles per query, men
// manifestet trenger bare sjekkes med jevne mellomrom.
const MANIFEST_CHECK_INTERVAL_MS = 60_000;
let lastManifestCheck = 0;

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

  // no-store: manifestet er lite og MÅ alltid være ferskt — det er nøkkelen
  // som forteller oss om parquet-innholdet har endret seg.
  const res = await fetch(manifestUrl, { cache: "no-store" });
  if (!res.ok) return;

  const entries: ManifestEntry[] = await res.json();
  if (!entries || entries.length === 0) return;

  let changed = false;
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name;
    const md5 = typeof entry === "string" ? undefined : entry.md5;
    const url = md5
      ? `${PARQUET_BASE}/${name}?v=${md5}`
      : `${PARQUET_BASE}/${name}`;

    if (registeredFiles.get(name) === url) continue;

    // Re-register if the file content changed mid-session (new md5)
    if (registeredFiles.has(name)) {
      try {
        await db.dropFile(name);
      } catch {
        // ignore — file may not have been buffered
      }
    }
    // Full absolute URL — DuckDB worker runs from a blob: origin and
    // cannot resolve relative paths.
    await db.registerFileURL(name, url, 4 /* DuckDBDataProtocol.HTTP */, false);
    registeredFiles.set(name, url);
    changed = true;
  }

  // Create or replace a view that unions all registered Parquet files.
  // This lets queries use a single table name "delays".
  if (changed && registeredFiles.size > 0) {
    const conn = await db.connect();
    try {
      const fileList = Array.from(registeredFiles.values())
        .map((u) => `'${u}'`)
        .join(", ");
      await conn.query(
        `CREATE OR REPLACE VIEW delays AS SELECT * FROM read_parquet([${fileList}])`,
      );
    } finally {
      await conn.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Delt spørringskjøring: SQL → rader som plain JS-objekter
// ---------------------------------------------------------------------------

async function runDuckQuery<T = Record<string, unknown>>(
  db: AsyncDuckDB,
  sql: string,
): Promise<T[]> {
  let conn: AsyncDuckDBConnection | null = null;
  try {
    conn = await db.connect();
    const result = await conn.query(sql);

    // Convert Arrow table to plain JS objects
    const rows: T[] = [];
    const numRows = result.numRows;
    const schema = result.schema.fields;

    for (let i = 0; i < numRows; i++) {
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
  } finally {
    if (conn) await conn.close();
  }
}

/**
 * Kjør en DuckDB-spørring utenfor React (brukes av stats-adapteren i
 * queryClient). Initialiserer DuckDB-singletonen og registrerer parquet-filene
 * ved behov — samme instans og `delays`-view som hooken bruker.
 */
export async function standaloneDuckQuery<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const db = await initDuckDB();
  await ensureFilesRegistered(db);
  if (registeredFiles.size === 0) {
    throw new Error("Ingen parquet-filer tilgjengelig");
  }
  return runDuckQuery<T>(db, sql);
}

// ---------------------------------------------------------------------------
// Hook: useParquetQuery
// ---------------------------------------------------------------------------

export interface ParquetQueryState {
  /** Whether Parquet files are being loaded / DuckDB is initializing */
  loading: boolean;
  /** Error message if something went wrong */
  error: string | null;
  /** Whether any Parquet files are available */
  ready: boolean;
  /** Run an arbitrary SQL query against loaded Parquet data.
   *  Supports ? parameter binding (replaced sequentially). */
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
}

export function useParquetQuery(): ParquetQueryState {
  const { db, loading: dbLoading, error: dbError } = useDuckDB();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const initDone = useRef(false);

  // Register Parquet files once DuckDB is ready
  useEffect(() => {
    if (!db || initDone.current) return;

    let cancelled = false;

    (async () => {
      try {
        await ensureFilesRegistered(db);
        if (!cancelled) {
          setReady(registeredFiles.size > 0);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg =
            err instanceof Error ? err.message : "Failed to load Parquet files";
          setError(msg);
          setLoading(false);
        }
      }
      initDone.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, [db]);

  // Propagate DuckDB-level errors
  useEffect(() => {
    if (dbError) {
      setError(dbError);
      setLoading(false);
    }
  }, [dbError]);

  const queryFn = useCallback(
    async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      if (!db) throw new Error("DuckDB not initialized");

      // Re-register files in case new weeks appeared since last check
      await ensureFilesRegistered(db);

      // Substitute ? placeholders with escaped parameter values.
      // DuckDB-WASM's JS API does not support native prepared-statement
      // parameter binding via conn.query(), so we inline them safely.
      let finalSql = sql;
      if (params && params.length > 0) {
        let idx = 0;
        finalSql = sql.replace(/\?/g, () => {
          if (idx >= params.length) return "NULL";
          const val = params[idx++];
          if (val === null || val === undefined) return "NULL";
          if (typeof val === "number" || typeof val === "bigint") return String(val);
          if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
          // String: escape single quotes
          return `'${String(val).replace(/'/g, "''")}'`;
        });
      }

      return runDuckQuery<T>(db, finalSql);
    },
    [db],
  );

  return {
    loading: dbLoading || loading,
    error,
    ready,
    query: queryFn,
  };
}
