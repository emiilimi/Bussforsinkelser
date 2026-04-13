import { useState, useEffect } from "react";
import * as duckdb from "@duckdb/duckdb-wasm";

// ---------------------------------------------------------------------------
// Singleton DuckDB-WASM instance
// ---------------------------------------------------------------------------

let dbInstance: duckdb.AsyncDuckDB | null = null;
let initPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    dbInstance = db;
    return db;
  })();

  return initPromise;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function useDuckDB(): {
  db: duckdb.AsyncDuckDB | null;
  loading: boolean;
  error: string | null;
} {
  const [db, setDb] = useState<duckdb.AsyncDuckDB | null>(dbInstance);
  const [loading, setLoading] = useState(!dbInstance);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (dbInstance) {
      setDb(dbInstance);
      setLoading(false);
      return;
    }

    let cancelled = false;

    initDuckDB()
      .then((instance) => {
        if (!cancelled) {
          setDb(instance);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "DuckDB init failed";
          setError(message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { db, loading, error };
}
