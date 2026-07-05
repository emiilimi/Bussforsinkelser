import { useState, useEffect } from "react";
import * as duckdb from "@duckdb/duckdb-wasm";

// ---------------------------------------------------------------------------
// Singleton DuckDB-WASM instance
// ---------------------------------------------------------------------------

let dbInstance: duckdb.AsyncDuckDB | null = null;
let initPromise: Promise<duckdb.AsyncDuckDB> | null = null;

export async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
      const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

      // Web Workers require same-origin scripts. Fetch the worker JS from
      // jsDelivr and wrap it in a Blob URL so the browser treats it as local.
      const workerResponse = await fetch(bundle.mainWorker!);
      const workerBlob = new Blob([await workerResponse.text()], {
        type: "application/javascript",
      });
      const workerUrl = URL.createObjectURL(workerBlob);

      const worker = new Worker(workerUrl);
      const logger = new duckdb.ConsoleLogger();
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

      // Clean up the blob URL (worker is already running)
      URL.revokeObjectURL(workerUrl);

      dbInstance = db;
      return db;
    } catch (err) {
      // Reset so next attempt can retry instead of re-using failed promise
      initPromise = null;
      throw err;
    }
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
          console.warn("[DuckDB]", message);
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
