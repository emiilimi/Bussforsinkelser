import { useState, useEffect, useCallback, useRef } from "react";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { useDuckDB, initDuckDB, warmupDuckDB } from "./use-duckdb";

// ---------------------------------------------------------------------------
// Base URL for Parquet files — falls back to local server during development.
// In production, point VITE_PARQUET_BASE_URL at Cloudflare R2 public URL.
// Eksportert: stats-adapteren henter artefaktene (stats_*.json) fra samme base.
// ---------------------------------------------------------------------------

// .trim() FØR slash-strippingen: et etterslepende mellomrom i env-variabelen
// (lett å få med seg ved liming i Cloudflare Pages sitt UI) ble tidligere med
// inn i URL-en som «%20», slik at vertsnavnet ble ugyldig og ALLE
// parquet-/manifest-kall feilet med ERR_NAME_NOT_RESOLVED — uten noen synlig
// feilmelding utover «Statistikk utilgjengelig». Skjedde i produksjon
// 2026-07-27 ved overgangen til parquet.sentur.no.
export const PARQUET_BASE =
  (import.meta as any).env?.VITE_PARQUET_BASE_URL?.trim().replace(/\/+$/, "") ||
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
// maxDate: siste dato i filen, skrevet av pipelinen fra parquetens
// radgruppe-statistikk. Valgfri — et manifest fra før dette feltet fantes
// fungerer som før (se latestAvailableDate).
type ManifestEntry = string | { name: string; md5?: string; maxDate?: string };

type RegisteredFile = {
  url: string;
  family: DelayFamily;
  week: string;
  fromIso: string;
  toIso: string;
  /** Faktisk siste dato i filen, når manifestet oppgir den. */
  maxDate?: string;
};

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
    const maxDate = typeof entry === "string" ? undefined : entry.maxDate;
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
    registeredFiles.set(name, { url, family: parsed.family, week: parsed.week, fromIso, toIso, maxDate });
  }
  // Manifestet bærer nå `maxDate`, så siste datadag er kjent i det filene er
  // registrert — uten å vente på noen spørring. Varsle lytterne slik at
  // useLatestDataDate() plukker den opp med det samme (den ble tidligere bare
  // vekket av primingen, som var det eneste stedet datoen kom fra).
  for (const l of Array.from(latestDateListeners)) l();
}

// Et enkelt mislykket forsøk (forbigående nettverksglipp, treg R2-edge ved
// kaldstart) skal ikke bli en PERMANENT feil for spørringer som går via
// React Query — queryClient er satt opp med retry:false og
// staleTime:Infinity, så uten denne retry-en her ville én glipp gitt en
// evig cachet feiltilstand for den spørringen, uten noen vei tilbake før
// brukeren endrer noe i URL-en (bytter stopp/linje) eller laster siden på
// nytt. Sett i produksjon: DuckDB-spørringer på stoppanalyse/linjeanalyse
// sto fast som "ingen data" etter én slik glipp.
const REGISTRATION_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

/** ensureFilesRegistered() med automatisk retry ved forbigående feil. */
async function registerFilesWithRetry(db: AsyncDuckDB): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ensureFilesRegistered(db);
      return;
    } catch (err) {
      const delay = REGISTRATION_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Sikrer at manifestet er lest og filene registrert — kall før
 *  latestAvailableDate() slik at den ikke leser et tomt kart. */
export async function ensureParquetFilesRegistered(): Promise<void> {
  const db = await initDuckDB();
  await registerFilesWithRetry(db);
}

// ---------------------------------------------------------------------------
// Metadata-priming
//
// Å registrere filene koster ingenting i seg selv — DuckDB leser først
// parquet-footerne (row group-statistikk for 35–70 MB store ukefiler) når
// den FØRSTE spørringen planlegges. Målt mot R2: første spørring 45,7 s,
// alle påfølgende ~5 s. Uten priming betaler brukeren de 45 sekundene rett
// etter at de har trykket «Finn reise».
//
// Derfor: kjør en billig aggregat-spørring som tvinger fram footer-lesing av
// alle registrerte filer i det brukeren gjør noe som varsler at statistikk
// snart trengs (velger et stopp). Da overlapper kostnaden med at de fyller
// ut resten av søket, i stedet for å ligge på den kritiske stien.
// ---------------------------------------------------------------------------

const primingPromises = new Map<DelayFamily, Promise<void>>();

// Faktisk siste datadag per familie, målt med MAX(date). Se
// latestDataDate() under for hvorfor dette ikke kan utledes fra filnavnet.
const measuredLatestDate = new Map<DelayFamily, string>();
const latestDateListeners = new Set<() => void>();

/**
 * Fire-and-forget: varm opp parquet-metadata for ÉN filfamilie.
 *
 * Oppgi familien siden hver primer okkuperer DuckDB-workeren (som tar én
 * spørring om gangen). Å prime begge på en side som bare bruker den ene
 * legger en unødvendig tung spørring foran den brukeren faktisk venter på —
 * målt gjorde det statistikken merkbart tregere når søket startet samtidig
 * (URL-gjenoppretting) i stedet for etter at brukeren hadde fylt ut skjemaet.
 *
 * MÅLT 2026-08-22 (duckdb + httpfs mot ekte R2, samme 10 by-stop-filer):
 *
 *     SELECT COUNT(*)              →  1 350 ms
 *     SELECT MAX(date)             → 12 022 ms
 *     SELECT COUNT(*), MAX(date)   → 10 430 ms
 *
 * Den gamle kommentaren her påsto at «begge deler besvares fra parquetens row
 * group-statistikk, så det koster ikke mer enn COUNT(*) alene». Det stemmer
 * ikke: MAX(date) er ~9× dyrere og sto for hele kostnaden. I nettleseren
 * (duckdb-wasm, mer HTTP-overhead) ble hele spørringen målt til ~54 s — den
 * største enkeltposten i reiseplanleggeren.
 *
 * MAX(date) er nå UNØDVENDIG: pipelinen skriver `maxDate` per fil i
 * manifestet, så den faktiske siste datadagen er allerede gratis tilgjengelig
 * (se manifestMaxDate/latestDataDate). Vi beholder COUNT(*) — det er den
 * billige delen, og det er den som varmer opp footerne, som er hele poenget
 * med primingen. MAX(date) tas bare med hvis manifestet mangler maxDate
 * (eldre artefakt), slik at oppførselen ikke regresserer der.
 */
export function primeParquetMetadata(family: DelayFamily = DEFAULT_FAMILY): void {
  if (primingPromises.has(family)) return;
  const view = `delays_${family.replace("-", "_")}`;
  const needMax = manifestMaxDate(family) === null;
  const p = standaloneDuckQuery<{ n: number; mx: string | null }>(
    needMax
      ? `SELECT COUNT(*) AS n, MAX(date) AS mx FROM ${view}`
      : `SELECT COUNT(*) AS n FROM ${view}`,
    undefined,
    { family },
  )
    .then((rows) => {
      const mx = rows[0]?.mx;
      if (mx) {
        measuredLatestDate.set(family, String(mx));
        for (const l of Array.from(latestDateListeners)) l();
      }
    })
    .catch(() => {
      // Priming er ren opportunisme — feiler den, tar den ordinære spørringen
      // kostnaden i stedet. Nullstill så et senere forsøk kan prøve på nytt.
      primingPromises.delete(family);
    });
  primingPromises.set(family, p);
}

/**
 * Den FAKTISKE siste datadagen (MAX(date)), eller null før priming er ferdig.
 *
 * Bruk denne — ikke latestAvailableDate() — som ankerpunkt for «N dager
 * tilbake». latestAvailableDate() utleder datoen fra filnavnet og returnerer
 * ukefilens SØNDAG, som kan ligge opptil seks dager etter siste faktiske
 * datadag (ingesten skriver gårsdagen, og ukefilen finnes fra ukas første
 * ingest). Som ankerpunkt skyver den vindusstarten like langt fram og gir
 * stille færre dager enn brukeren ba om — målt 9. august 2026 (data t.o.m.
 * 7. august) ga «Siste 7 dager» bare 5 dager, og tidlig i uka ned mot 1.
 */
export function latestDataDate(family: DelayFamily = DEFAULT_FAMILY): string | null {
  return measuredLatestDate.get(family) ?? manifestMaxDate(family);
}

/**
 * Siste FAKTISKE datadag slik pipelinen selv oppga den i manifestet, eller
 * null hvis manifestet ikke har feltet.
 *
 * Skiller seg fra latestAvailableDate() ved at den ALDRI faller tilbake på
 * ukefilens søndag. Den tilnærmingen er trygg når man skal velge hvilke filer
 * som skal åpnes (for høy = tar med en fil for mye), men FARLIG som ankerpunkt
 * for «siste N dager»: den kan ligge opptil seks dager etter siste datadag og
 * gir da stille et kortere vindu enn brukeren ba om.
 */
function manifestMaxDate(family: DelayFamily): string | null {
  let max: string | null = null;
  for (const f of Array.from(registeredFiles.values())) {
    if (f.family !== family || !f.maxDate) continue;
    if (max === null || f.maxDate > max) max = f.maxDate;
  }
  return max;
}

/** React-hook: siste datadag, oppdateres når primingen lander. */
export function useLatestDataDate(family: DelayFamily = DEFAULT_FAMILY): string | null {
  const [value, setValue] = useState<string | null>(() => latestDataDate(family));
  useEffect(() => {
    const listener = () => setValue(latestDataDate(family));
    latestDateListeners.add(listener);
    listener(); // kan ha landet mellom render og effekt
    return () => { latestDateListeners.delete(listener); };
  }, [family]);
  return value;
}

/**
 * Seneste dato vi har data for i gitt familie. Gratis (ingen DuckDB-spørring)
 * — leses av manifestet som allerede er hentet.
 *
 * Bruker `maxDate` fra manifestet når pipelinen har skrevet den: da er dette
 * den FAKTISKE siste datadagen, og trygg å bruke som ankerpunkt for «siste N
 * dager».
 *
 * Uten `maxDate` (manifest fra før feltet fantes) faller vi tilbake på ISO-
 * ukens søndag utledet av FILNAVNET. Det er en øvre tilnærming — aldri for
 * lav, men potensielt opptil seks dager FOR HØY, siden ukefilen finnes fra
 * ukas første ingest mens dataene bare rekker til i går. Som ankerpunkt for
 * «fra = anker − (N−1)» skyver det vindusstarten like langt fram og gir
 * stille færre dager enn brukeren ba om (målt 9. august 2026: «siste 7 dager»
 * ga 5). Derfor foretrekkes maxDate alltid når den finnes.
 */
export function latestAvailableDate(family: DelayFamily = DEFAULT_FAMILY): string | null {
  let measured: string | null = null;
  let approximated: string | null = null;
  for (const f of Array.from(registeredFiles.values())) {
    if (f.family !== family) continue;
    if (f.maxDate && (measured === null || f.maxDate > measured)) measured = f.maxDate;
    if (approximated === null || f.toIso > approximated) approximated = f.toIso;
  }
  return measured ?? approximated;
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
/** Siste filsett viewet ble bygget med, per familie — kun til måling, slik at
 *  vi kan se om en dyr spørring faller sammen med at filsettet ENDRET seg
 *  (hypotesen om at footer-kostnaden betales på nytt per datovindu). */
const lastViewFiles = new Map<DelayFamily, string>();

async function prepareView(
  conn: AsyncDuckDBConnection,
  family: DelayFamily,
  fromDate?: string,
  toDate?: string,
): Promise<string> {
  const viewName = `delays_${family.replace("-", "_")}`;
  const files = filesForFamily(family, fromDate, toDate);
  const key = files.join("|");
  const changed = lastViewFiles.get(family) !== key;
  lastViewFiles.set(family, key);
  const t0 = performance.now();
  if (files.length === 0) {
    // Ingen registrerte uker overlapper vinduet — tom, men gyldig, view.
    await conn.query(`CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_parquet([]) WHERE 1=0`);
    recordTiming("view-setup", performance.now() - t0, `[0 filer] changed=${changed}`);
    return viewName;
  }
  const fileList = files.map((u) => `'${u}'`).join(", ");
  await conn.query(`CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_parquet([${fileList}])`);
  recordTiming(
    "view-setup",
    performance.now() - t0,
    `[${files.length} filer, ${family}] changed=${changed} window=${fromDate ?? "*"}..${toDate ?? "*"}`,
  );
  return viewName;
}

// ---------------------------------------------------------------------------
// Serialisering + begrenset retry rundt prepareView+spørring.
//
// SERIALISERING: prepareView (CREATE OR REPLACE VIEW ...) og den påfølgende
// SELECT-en er to SEPARATE .query()-kall mot samme delte, navngitte view
// (delays_by_line/delays_by_stop — se prepareView over). DuckDB-wasm kjører
// alt gjennom én worker-tråd, men REKKEFØLGEN kallene når worker-en i styres
// av JS-hendelsesløkkas mikrotask-rekkefølge på tvers av SAMTIDIGE kall.
// Uten denne muteksen kan én spørrings prepareView (f.eks. "siste 2 uker")
// bli etterfulgt av en ANNEN samtidig spørrings prepareView ("siste uke") FØR
// den første rekker sin egen SELECT — som da leser feil vindus datasett.
// Stoppanalysens flere hooks (linjer/timesprofil/enkeltavganger + dagstrend)
// bytter alle vindu SAMTIDIG når brukeren endrer periode, så dette er ikke et
// teoretisk hjørnetilfelle.
//
// RETRY: samme begrunnelse som registerFilesWithRetry over — queryClient sin
// globale retry:false betyr at ÉN forbigående glipp (nettverk, akkurat denne
// racen, midlertidig kontensjon) gir en PERMANENT feil-cachet spørring for
// akkurat den (stopp/linje, vindu)-kombinasjonen, uten vei tilbake før siden
// lastes på nytt. Sett i praksis: bytt periode i stoppanalysen rett etter et
// tregt førstelast, og visningen sitter fast på det gamle vinduets tall.
let queryMutex: Promise<void> = Promise.resolve();
const QUERY_RETRY_DELAYS_MS = [500, 1500];

// Hvor mange spørringer som står i kø eller kjører akkurat nå. Brukes av
// whenDuckIdle() — se der for hvorfor.
let pendingQueries = 0;

/**
 * Venter til DuckDB-worker'en har vært HELT ledig sammenhengende i `idleMs`.
 *
 * Finnes for spørringer som er rene «nice to have» og aldri skal stå foran
 * noe brukeren venter på. Worker'en tar én spørring om gangen og kan ikke
 * avbrytes, så en tung bakgrunnsspørring som sniker seg inn i køen forsinker
 * alt bak den (målt: COUNT(DISTINCT date) = 81,6 s, og den matet bare en
 * kosmetisk linje — se NOTES.md punkt 4).
 *
 * Merk: dette forhindrer at spørringen STARTER på et dårlig tidspunkt. Når
 * den først er i gang kan den ikke stoppes — derfor bør den bare brukes til
 * ting som tåler å komme sent, og helst når køen har roet seg helt.
 */
export function whenDuckIdle(idleMs = 4000, timeoutMs = 300_000): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let idleSince: number | null = pendingQueries === 0 ? Date.now() : null;
    const tick = () => {
      if (Date.now() - startedAt > timeoutMs) return resolve(false);
      if (pendingQueries > 0) {
        idleSince = null;
      } else {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= idleMs) return resolve(true);
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  });
}

async function runSerializedWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  const runOnce = (): Promise<T> => {
    pendingQueries += 1;
    const scheduled = queryMutex.then(fn, fn).finally(() => {
      pendingQueries -= 1;
    });
    queryMutex = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce();
    } catch (err) {
      const delay = QUERY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Delt spørringskjøring: SQL → rader som plain JS-objekter
// ---------------------------------------------------------------------------

/**
 * Grovklassifisering av en spørring, kun til ytelsesmåling. Vi har ingen
 * label-parameter gjennom alle kallestedene, så vi kjenner igjen formen på
 * SQL-en i stedet.
 */
function classifyQuery(sql: string): string {
  // Overgangs-gap: UNION-en i lib/trip-shared.ts merker hvert spor med en
  // src-kolonne ('S'/'A'/'P'). Å kjenne igjen JOIN-en (arr.date = dep.date)
  // alene var ikke nok — de havnet som "other" og ble usynlige i summary().
  if (/AS src\b/i.test(sql) && /\bgap\b/i.test(sql)) return "transfer-gap";
  if (/arr\.date\s*=\s*dep\.date/.test(sql)) return "transfer-gap";
  if (/PERCENTILE_CONT/.test(sql)) {
    if (/GROUP BY\s+stop_ref,\s*line_ref/i.test(sql)) return "percentiles";
    if (/FROM\s+delays_by_line/i.test(sql)) return "sj-detail";       // «hele avgangen»
    return "percentiles-other";
  }
  if (/COUNT\(DISTINCT date\)/i.test(sql)) return "data-daycount";
  if (/COUNT\(\*\)\s+AS n,\s*MAX\(date\)/i.test(sql)) return "metadata-priming";
  if (/MIN\(date\)/i.test(sql) && /MAX\(date\)/i.test(sql)) return "data-range";
  if (/service_journey_id/.test(sql) && /stop_sequence/.test(sql)) return "leg-timing";
  if (/CREATE\s+OR\s+REPLACE\s+VIEW/i.test(sql)) return "view-setup";
  return "other";
}

/**
 * Ytelsesteller per spørringstype, lagt på `window.__duckTimings`.
 * Alltid på — kostnaden er én Date.now()-differanse per spørring, og uten den
 * er «hvor blir tiden av?» ren gjetting (vi har allerede tatt feil to ganger
 * på nettopp det, se NOTES.md punkt 8). Nullstill med
 * `window.__duckTimings.reset()`.
 */
type DuckTimingEntry = { label: string; ms: number; at: number; sql?: string };
function recordTiming(label: string, ms: number, sql?: string): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __duckTimings?: {
    entries: DuckTimingEntry[]; summary(): Record<string, { n: number; totalMs: number }>; reset(): void;
  } };
  if (!w.__duckTimings) {
    const entries: DuckTimingEntry[] = [];
    w.__duckTimings = {
      entries,
      summary() {
        const out: Record<string, { n: number; totalMs: number }> = {};
        for (const e of entries) {
          out[e.label] ??= { n: 0, totalMs: 0 };
          out[e.label].n += 1;
          out[e.label].totalMs += e.ms;
        }
        return out;
      },
      reset() { entries.length = 0; },
    };
  }
  w.__duckTimings.entries.push({
    label,
    ms: Math.round(ms),
    at: Math.round(performance.now()),
    sql: sql?.replace(/\s+/g, " ").trim().slice(0, 160),
  });
}

async function runQueryOnConn<T = Record<string, unknown>>(
  conn: AsyncDuckDBConnection,
  sql: string,
): Promise<T[]> {
  const _t0 = performance.now();
  const result = await conn.query(sql);
  recordTiming(classifyQuery(sql), performance.now() - _t0, sql);
  const rows: T[] = [];
  const schema = result.schema.fields;
  for (let i = 0; i < result.numRows; i++) {
    const row: Record<string, unknown> = {};
    for (const field of schema) {
      const col = result.getChild(field.name);
      const val = col?.get(i) ?? null;
      // DuckDB returns COUNT(*) etc. as BigInt — convert to Number
      if (typeof val === "bigint") {
        row[field.name] = Number(val);
      } else if (val instanceof Uint32Array) {
        // SUM(<heltall>) gir HUGEINT (INT128) i DuckDB, som Arrow sender som
        // Decimal128 — i JS en Uint32Array på fire ord, IKKE et tall. Uten
        // denne konverteringen slipper objektet urørt ut i UI-et, og det er
        // to ulike feil, begge stille:
        //   `${v}.toLocaleString("nb-NO")` → "99 090,0,0,0" (TypedArray-
        //      varianten formaterer hvert ord for seg) — se rutevariant-
        //      nedtrekket i linjeanalysen, meldt inn 2026-08-15.
        //   `sum + v` → STRENGSAMMENSETNING ("99090" + "0" = "990900"), altså
        //      et plausibelt, men helt feil tall i enhver reduce().
        // Number() håndterer hele INT128-området vi bryr oss om her.
        // Uint32Array (ikke ArrayBuffer.isView) er med vilje: en ekte BLOB
        // ville kommet som Uint8Array og skal ikke tallkonverteres.
        row[field.name] = Number(val);
      } else {
        row[field.name] = val;
      }
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
  /**
   * Tidsavbrudd i millisekunder for selve KJØRINGEN — klokka starter når
   * spørringen faktisk får worker'en, ikke når den legges i kø.
   *
   * Det skillet er hele poenget. Worker'en tar én spørring om gangen, og en
   * kaldstart-priming kan holde den i ~55 s. Et tidsavbrudd som teller fra
   * kø-tidspunktet ville da avbryte spørringer som ennå ikke hadde begynt å
   * kjøre — de «feilet» uten å ha fått forsøke. Det var nettopp det som
   * skjedde med overgangs-gapene: 15 s frist, målt kjøretid 8–15 s, og
   * dermed avbrutt en masse så snart det lå noe foran dem i køen.
   */
  timeoutMs?: number;
}

/** Avviser hvis `promise` ikke er ferdig innen `ms`. Brukes rundt selve
 *  kjøringen (etter muteksen), aldri rundt kø-ventingen. */
function withExecTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`DuckDB-spørring tidsavbrutt etter ${ms}ms (kjøretid)`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
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
  await registerFilesWithRetry(db);
  if (registeredFiles.size === 0) {
    throw new Error("Ingen parquet-filer tilgjengelig");
  }
  return runSerializedWithRetry(async () => {
    const conn = await db.connect();
    try {
      const exec = (async () => {
        await prepareView(conn, options?.family ?? DEFAULT_FAMILY, options?.fromDate, options?.toDate);
        return await runQueryOnConn<T>(conn, bindParams(sql, params));
      })();
      // Klokka starter HER — etter muteksen — så kø-venting ikke teller.
      return await (options?.timeoutMs ? withExecTimeout(exec, options.timeoutMs) : exec);
    } finally {
      await conn.close();
    }
  });
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

  // Register Parquet files once DuckDB is ready — registerFilesWithRetry
  // gjør allerede automatisk retry ved forbigående feil.
  useEffect(() => {
    if (!db || initDone.current) return;

    let cancelled = false;
    setRegistering(true);
    setError(null);

    (async () => {
      try {
        await registerFilesWithRetry(db);
        if (!cancelled) {
          setReady(registeredFiles.size > 0);
          setRegistering(false);
          setError(null);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg =
            err instanceof Error ? err.message : "Failed to load Parquet files";
          setError(msg);
          setRegistering(false);
        }
      }
      initDone.current = true;
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

      return runSerializedWithRetry(async () => {
        const conn = await db.connect();
        try {
          const exec = (async () => {
            await prepareView(conn, options?.family ?? DEFAULT_FAMILY, options?.fromDate, options?.toDate);
            return await runQueryOnConn<T>(conn, bindParams(sql, params));
          })();
          // Klokka starter HER — etter muteksen — så kø-venting ikke teller.
          return await (options?.timeoutMs ? withExecTimeout(exec, options.timeoutMs) : exec);
        } finally {
          await conn.close();
        }
      });
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
