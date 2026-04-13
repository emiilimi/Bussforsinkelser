import { useState, useEffect, useCallback, useRef } from "react";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { useDuckDB } from "./use-duckdb";

// ---------------------------------------------------------------------------
// Track which Parquet files have been registered in DuckDB
// ---------------------------------------------------------------------------

const registeredFiles = new Set<string>();

async function ensureFilesRegistered(db: AsyncDuckDB): Promise<void> {
  // Fetch the manifest of available week files
  const res = await fetch("/api/parquet/manifest");
  if (!res.ok) return;

  const files: string[] = await res.json();
  if (!files || files.length === 0) return;

  for (const file of files) {
    if (registeredFiles.has(file)) continue;

    const url = `/api/parquet/${file}`;
    await db.registerFileURL(file, url, 4 /* DuckDBDataProtocol.HTTP */, false);
    registeredFiles.add(file);
  }

  // Create or replace a view that unions all registered Parquet files.
  // This lets queries use a single table name "delays".
  if (registeredFiles.size > 0) {
    const conn = await db.connect();
    try {
      const fileList = Array.from(registeredFiles)
        .map((f) => `'${f}'`)
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
// Hook: useParquetQuery
// ---------------------------------------------------------------------------

export interface ParquetQueryState {
  /** Whether Parquet files are being loaded / DuckDB is initializing */
  loading: boolean;
  /** Error message if something went wrong */
  error: string | null;
  /** Whether any Parquet files are available */
  ready: boolean;
  /** Run an arbitrary SQL query against loaded Parquet data */
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
      _params?: unknown[],
    ): Promise<T[]> => {
      if (!db) throw new Error("DuckDB not initialized");

      // Re-register files in case new weeks appeared since last check
      await ensureFilesRegistered(db);

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
            row[field.name] = col?.get(i) ?? null;
          }
          rows.push(row as T);
        }

        return rows;
      } finally {
        if (conn) await conn.close();
      }
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
