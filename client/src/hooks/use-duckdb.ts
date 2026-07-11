import { useState, useEffect } from "react";
import * as duckdb from "@duckdb/duckdb-wasm";

// ---------------------------------------------------------------------------
// Singleton DuckDB-WASM instance — LAT init (juli 2026)
//
// WASM-binæren er ~7–8 MB gzippet fra jsDelivr. Tidligere initialiserte
// useDuckDB() ved mount, og siden reiseplanleggeren (landingssiden) bruker
// hooken, begynte nedlastingen i det øyeblikket en mobilbruker åpnet siten —
// før de hadde gjort noe som helst som trenger den.
//
// Nå er hooken PASSIV: den speiler singleton-tilstanden, men starter aldri
// initialisering selv. Init skjer kun via:
//   - warmupDuckDB()      — kalles fra sidene når brukeren faktisk gjør noe
//                           som kommer til å trenge DuckDB (velger stopp,
//                           starter et søk, velger en linje)
//   - initDuckDB()        — awaites direkte av standaloneDuckQuery m.fl.
// ---------------------------------------------------------------------------

let dbInstance: duckdb.AsyncDuckDB | null = null;
let initPromise: Promise<duckdb.AsyncDuckDB> | null = null;
let initError: string | null = null;

// Pub/sub så passive hooks får beskjed når tilstanden endres.
type Listener = () => void;
const listeners = new Set<Listener>();

function notifyListeners(): void {
  for (const l of Array.from(listeners)) l();
}

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
      // VoidLogger, ikke ConsoleLogger: ConsoleLogger logger hver eneste
      // interne buffer-/IO-operasjon — tusenvis av console-meldinger under
      // R2-spørringer, som både koster ytelse (spesielt mobil) og kunne
      // fryse fanen når devtools/utvidelser lytter på konsollen.
      const logger = new duckdb.VoidLogger();
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

      // Clean up the blob URL (worker is already running)
      URL.revokeObjectURL(workerUrl);

      dbInstance = db;
      initError = null;
      notifyListeners();
      return db;
    } catch (err) {
      // Reset so next attempt can retry instead of re-using failed promise
      initPromise = null;
      initError = err instanceof Error ? err.message : "DuckDB init failed";
      notifyListeners();
      throw err;
    }
  })();

  notifyListeners(); // loading startet
  return initPromise;
}

/**
 * Start DuckDB-initialisering i bakgrunnen (fire-and-forget). Kalles fra
 * sidene i det øyeblikket brukeren gjør noe som kommer til å trenge DuckDB —
 * f.eks. velger et stoppested eller starter et reisesøk — slik at nedlastingen
 * overlapper med brukerens neste steg i stedet for å blokkere første sidelast.
 * Idempotent og billig å kalle flere ganger.
 */
export function warmupDuckDB(): void {
  initDuckDB().catch(() => {
    // Feilen er allerede fanget/publisert via initError + notifyListeners;
    // konsumenter viser den via useDuckDB().error.
  });
}

// ---------------------------------------------------------------------------
// React hook — passiv speiling av singleton-tilstanden
// ---------------------------------------------------------------------------

export function useDuckDB(): {
  db: duckdb.AsyncDuckDB | null;
  /** true kun mens en initialisering faktisk pågår */
  loading: boolean;
  /** true når ingen init er startet ennå (kall warmupDuckDB for å starte) */
  idle: boolean;
  error: string | null;
} {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const listener = () => forceUpdate((n) => n + 1);
    listeners.add(listener);
    // Tilstanden kan ha endret seg mellom render og effekt-kjøring
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return {
    db: dbInstance,
    loading: dbInstance === null && initPromise !== null,
    idle: dbInstance === null && initPromise === null && initError === null,
    error: initError,
  };
}
