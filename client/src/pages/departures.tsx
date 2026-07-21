import { useQuery, keepPreviousData } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState, useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { Search, Clock, AlertCircle, Loader2 } from "lucide-react";
import { ModeIcon } from "@/components/mode-icon";
import { cn, formatStopName } from "@/lib/utils";
import { useRegion } from "@/lib/RegionContext";
import { useParquetQuery, type QueryOptions } from "@/hooks/use-parquet-query";
import { warmupDuckDB } from "@/hooks/use-duckdb";
import { InfoTip } from "@/components/info-tip";
import { IS_REISE } from "@/lib/app-mode";
import { BusLoading } from "@/components/bus-loading";
import { RegionSelector } from "@/components/region-selector";
import { StopAnalysisSection } from "@/components/stop-analysis-section";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Quay = { stopRef: string; platformCode: string };
type SearchResult = {
  stopRef: string;
  stopName: string | null;
  platformCodes: string | null;
  quays: Quay[];
};

type Departure = {
  aimedTime: string;
  expectedTime: string | null;
  aimedArrivalTime: string | null;
  expectedArrivalTime: string | null;
  realtime: boolean;
  cancelled: boolean;
  destination: string | null;
  quayRef: string | null;
  quayName: string | null;
  platform: string | null;
  lineRef: string | null;
  lineNumber: string | null;
  lineName: string | null;
  transportMode: string | null;
  serviceJourneyId: string | null;
  directionRef: string | null;
};

type DeparturesResponse = {
  stopRef: string | null;
  stopName: string | null;
  departures: Departure[];
};

type SjCall = {
  quayRef: string | null;
  quayName: string | null;
  platform: string | null;
  aimedArrival: string | null;
  expectedArrival: string | null;
  aimedDeparture: string | null;
  expectedDeparture: string | null;
  realtime: boolean;
  cancelled: boolean;
  destination: string | null;
};

type SjResponse = {
  serviceJourneyId: string;
  line: { lineRef: string; publicCode: string | null; name: string | null; transportMode: string | null } | null;
  date: string;
  calls: SjCall[];
};

type DuckDelayRow = {
  stop_ref: string;
  line_ref: string;
  p50_dep: number | null;
  p80_dep: number | null;
  p95_dep: number | null;
  n: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string) { return s.replace(/'/g, "''"); }

function fmtHM(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Minutes between expected and aimed (positive = late). Null if no realtime.
 *  I ankomstmodus brukes ankomsttidene (fallback til avgang for første stopp). */
function realtimeDelayMin(d: Departure, mode: "departure" | "arrival"): number | null {
  const aimed = mode === "arrival" ? (d.aimedArrivalTime ?? d.aimedTime) : d.aimedTime;
  const expected = mode === "arrival" ? (d.expectedArrivalTime ?? d.expectedTime) : d.expectedTime;
  if (!d.realtime || !expected || !aimed) return null;
  return Math.round((new Date(expected).getTime() - new Date(aimed).getTime()) / 60000);
}

/** Tidspunktet som vises/sorteres på, avhengig av avgang/ankomst-modus. */
function displayTime(d: Departure, mode: "departure" | "arrival"): string {
  return mode === "arrival" ? (d.aimedArrivalTime ?? d.aimedTime) : d.aimedTime;
}

function delayBadgeClass(delayMin: number | null): string {
  if (delayMin == null) return "";
  if (delayMin <= 1) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (delayMin <= 4) return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30";
}

/** Turn "+0" into "i rute", "-2" into "-2m", "+3" into "+3m" */
function fmtDeltaMin(m: number): string {
  if (m === 0) return "i rute";
  return m > 0 ? `+${m}m` : `${m}m`;
}

function addMinToIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d.toISOString();
}

/** Linjenummer å vise: publicCode hvis vi har det, ellers siste ledd av
 *  line_ref — men bare hvis det faktisk ligner et linjenummer (korte koder
 *  som "6" eller "16E"). Noen historiske rader har uregistrerte/interne
 *  line_ref-er uten "Operatør:Line:N"-form (f.eks. en ren UUID) — da vises "?"
 *  i stedet for å dumpe hele strengen i UI-et. */
function lineNumberOf(d: Departure): string {
  if (d.lineNumber) return d.lineNumber;
  const suffix = d.lineRef ? d.lineRef.split(":").pop() ?? "" : "";
  return suffix && suffix.length <= 6 ? suffix : "?";
}

// ---------------------------------------------------------------------------
// Utvidet visning: hele reisen for én avgang (klikk på en rad)
// ---------------------------------------------------------------------------

type SjStopStat = {
  stop_ref: string;
  p50_dep: number | null;
  p80_dep: number | null;
  p50_arr: number | null;
  p80_arr: number | null;
  n: number;
  source: "sj" | "line";
};

function JourneyDetail({
  sjId,
  dateIso,
  lineRef,
  highlightQuay,
  duckReady,
  duckQuery,
}: {
  sjId: string;
  dateIso: string; // aimedTime for den klikkede avgangen
  lineRef: string | null;
  highlightQuay: string | null;
  duckReady: boolean;
  duckQuery: (sql: string, params?: unknown[], options?: QueryOptions) => Promise<any[]>;
}) {
  const date = dateIso.slice(0, 10);
  const { data: sj, isLoading, isError } = useQuery<SjResponse>({
    queryKey: [`/api/servicejourney/${encodeURIComponent(sjId)}?date=${date}`],
    refetchInterval: 60_000,
  });

  // Per-stopp P50/P80 fra DuckDB: helst for akkurat denne avgangen
  // (service_journey_id), ellers for linjen ved stoppet.
  const { data: statMap, isLoading: statMapLoading } = useQuery<Map<string, SjStopStat>>({
    queryKey: ["duck-sj-stops", sjId, lineRef ?? ""],
    enabled: duckReady,
    staleTime: Infinity,
    queryFn: async () => {
      const map = new Map<string, SjStopStat>();
      const cols = `
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_departure_min) AS p50_dep,
        PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_departure_min) AS p80_dep,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_arrival_min)   AS p50_arr,
        PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_arrival_min)   AS p80_arr,
        COUNT(*) AS n`;
      // Linjenivå først (bredest), deretter overskriv med SJ-nivå der vi har
      // nok observasjoner på akkurat denne avgangen.
      if (lineRef) {
        const lineRows = await duckQuery(`
          SELECT stop_ref, ${cols} FROM delays_by_line
          WHERE line_ref = '${esc(lineRef)}'
          GROUP BY stop_ref`, undefined, { family: "by-line" }) as Array<Omit<SjStopStat, "source">>;
        for (const r of lineRows) map.set(r.stop_ref, { ...r, source: "line" });
      }
      const sjRows = await duckQuery(`
        SELECT stop_ref, ${cols} FROM delays_by_line
        WHERE service_journey_id = '${esc(sjId)}'
        GROUP BY stop_ref`, undefined, { family: "by-line" }) as Array<Omit<SjStopStat, "source">>;
      for (const r of sjRows) {
        if (r.n >= 3) map.set(r.stop_ref, { ...r, source: "sj" });
      }
      return map;
    },
  });

  if (isLoading) {
    return (
      <div className="py-2 pl-8">
        <BusLoading label="Henter hele reisen" scale={0.42} />
      </div>
    );
  }
  if (isError || !sj || sj.calls.length === 0) {
    return <div className="py-3 pl-14 text-xs text-muted-foreground">Fant ikke stopplisten for denne avgangen.</div>;
  }

  const anySj = Array.from(statMap?.values() ?? []).some((s) => s.source === "sj");

  return (
    <div className="py-2 pl-8 pr-2 bg-muted/20 rounded-md mb-2">
      <div className="text-[10px] text-muted-foreground mb-1.5 flex items-center gap-2 flex-wrap">
        <span className="font-medium">
          Linje {sj.line?.publicCode ?? "?"} · hele reisen ({sj.calls.length} stopp)
        </span>
        <span>Rutetid</span>
        <span className="text-emerald-600">sanntid</span>
        <span className="text-amber-500">~P50</span>
        <span className="text-red-500/80">P80</span>
        {statMap && statMap.size > 0 && (
          <span className="italic">
            {anySj ? "statistikk for akkurat denne avgangen" : "statistikk for linjen ved hvert stopp"}
          </span>
        )}
      </div>
      <div className="space-y-0.5">
        {sj.calls.map((c, i) => {
          const isLast = i === sj.calls.length - 1;
          const aimed = isLast ? (c.aimedArrival ?? c.aimedDeparture) : (c.aimedDeparture ?? c.aimedArrival);
          const expected = isLast ? (c.expectedArrival ?? c.expectedDeparture) : (c.expectedDeparture ?? c.expectedArrival);
          const rtDelta = c.realtime && aimed && expected
            ? Math.round((new Date(expected).getTime() - new Date(aimed).getTime()) / 60000)
            : null;
          const stat = c.quayRef ? statMap?.get(c.quayRef) : null;
          const p50 = isLast ? stat?.p50_arr : stat?.p50_dep;
          const p80 = isLast ? stat?.p80_arr : stat?.p80_dep;
          const isHighlight = c.quayRef != null && c.quayRef === highlightQuay;
          return (
            <div
              key={`${c.quayRef ?? "q"}-${i}`}
              className={cn(
                "flex items-center gap-2 text-xs py-0.5 px-1 rounded",
                isHighlight && "bg-primary/10 font-medium",
                c.cancelled && "opacity-60 line-through",
              )}
            >
              <div className={cn(
                "w-1.5 h-1.5 rounded-full flex-shrink-0",
                i === 0 || isLast ? "bg-primary" : "bg-muted-foreground/40",
              )} />
              <span className="flex-1 truncate">
                {c.quayName ?? "—"}
                {c.platform && <span className="text-[10px] text-muted-foreground ml-1">Plt. {c.platform}</span>}
              </span>
              <span className="font-mono text-[11px] tabular-nums">{fmtHM(aimed)}</span>
              {rtDelta != null ? (
                <Badge variant="outline" className={cn("font-mono text-[9px] px-1 py-0", delayBadgeClass(rtDelta))}>
                  {fmtDeltaMin(rtDelta)}
                </Badge>
              ) : (
                <span className="w-8 text-center text-[9px] text-muted-foreground/40">—</span>
              )}
              <span className="font-mono text-[10px] tabular-nums text-amber-500 w-12 text-right">
                {aimed && p50 != null ? `~${fmtHM(addMinToIso(aimed, p50))}` : ""}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-red-500/80 w-11 text-right">
                {aimed && p80 != null ? fmtHM(addMinToIso(aimed, p80)) : ""}
              </span>
            </div>
          );
        })}
      </div>
      {(!duckReady || statMapLoading) && (
        <p className="text-[10px] text-muted-foreground/60 italic mt-1.5">
          Laster historiske observasjoner…
        </p>
      )}
      {duckReady && !statMapLoading && (!statMap || statMap.size === 0) && (
        <p className="text-[10px] text-muted-foreground/60 italic mt-1.5">
          Ingen historiske observasjoner for denne linjen ennå — kun rutetider og sanntid vises.
        </p>
      )}
      {lineRef && (
        <a
          href={`/journey?line=${encodeURIComponent(lineRef)}`}
          className="text-[10px] text-primary hover:underline inline-block mt-1.5"
        >
          Full linjeanalyse →
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Departures() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const { operators } = useRegion();
  const opStr = operators.length ? `operator=${operators.join(",")}` : "";

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedStop, setSelectedStop] = useState<{ ref: string; name: string } | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [minutes, setMinutes] = useState(90);
  // Avgang (når bussen forlater stoppet) vs ankomst (når den kommer inn)
  const [mode, setMode] = useState<"departure" | "arrival">("departure");
  // Valgt tidspunkt. Tomt = "nå" (live-visning med auto-refresh hvert minutt).
  // Satt = fast vindu fra valgt tid — Entur støtter også tidspunkt bakover i
  // tid (startTime), men sanntidsdata for passerte avganger finnes bare i en
  // kort periode; lenger tilbake vises kun rutetider.
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("");
  // Utvidet avgang (viser hele reisen). Nøkkel = sjId + aimedTime.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const startIso = useMemo(() => {
    if (!customDate || !customTime) return null;
    const d = new Date(`${customDate}T${customTime}:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [customDate, customTime]);
  // Entur sin sanntidstavle holder bare et kort vindu bakover i tid — søk
  // lenger tilbake gir tomt resultat der. For slike søk bruker vi i stedet
  // egne historiske data (journey_stop_daily via DuckDB), se lenger ned.
  const isHistorical = startIso != null && new Date(startIso).getTime() < Date.now() - 5 * 60_000;

  const nowDate = () => new Date().toISOString().slice(0, 10);
  const nowTime = () => {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
  };

  // Auto-select stop from URL params (?stop=NSR:StopPlace:X&name=…)
  useEffect(() => {
    const params = new URLSearchParams(search);
    const stopRef = params.get("stop");
    const stopName = params.get("name");
    if (stopRef && !selectedStop) {
      setSelectedStop({ ref: stopRef, name: stopName ?? stopRef });
      setQuery(stopName ?? stopRef);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Reise-bygget har ingen SQLite-backend → bruk Entur Geocoder (samme som
  // reiseplanleggeren). Det fulle nettstedet bruker DB-søket som før.
  const searchUrl = IS_REISE
    ? `/api/geocoder/autocomplete?text=${encodeURIComponent(debouncedQuery)}&size=8`
    : `/api/stops/search?q=${encodeURIComponent(debouncedQuery)}`;

  const { data: rawSearch = [] } = useQuery<any[]>({
    queryKey: [searchUrl],
    enabled: debouncedQuery.length >= 2,
  });

  // Normaliser begge kildene til SearchResult[]. Geocoder returnerer både
  // stoppesteder (layer "venue", NSR-id) og adresser — bare stoppesteder kan
  // gi avganger, så adresser filtreres bort.
  const searchResults: SearchResult[] = useMemo(() => {
    if (!IS_REISE) return rawSearch as SearchResult[];
    return (rawSearch as Array<{ id: string; name: string; layer: string }>)
      .filter((r) => r.layer === "venue" && typeof r.id === "string" && r.id.startsWith("NSR:"))
      .map((r) => ({ stopRef: r.id, stopName: r.name, platformCodes: null, quays: [] }));
  }, [rawSearch]);

  const stopRef = selectedStop?.ref ?? null;

  // Lat DuckDB-init: start WASM-nedlastingen først når et stopp er valgt —
  // det er da P80-kolonnen og reisedetaljene faktisk trenger den.
  useEffect(() => {
    if (stopRef) warmupDuckDB();
  }, [stopRef]);

  // DuckDB-WASM percentiles per (quay, line) pair seen in the departure list.
  // Flyttet opp hit (før depResp) fordi den historiske avgangslisten under
  // også trenger duckReady/duckQuery.
  const { ready: duckReady, query: duckQuery } = useParquetQuery();

  // Departures from Entur (1-minute server cache + 60s client refresh).
  // Ved valgt tidspunkt (startIso) er vinduet fast — ingen auto-refresh.
  // view=arrivals gir også avganger som KUN ankommer stoppet (endeholdeplass) —
  // uten den er «Ankomster» bare avgangslisten med ankomsttider.
  // Prøves NÅ også for historiske datoer — Entur viser faktisk rutetider (og
  // ekte destinasjon!) opptil ~3 dager tilbake, bare uten sanntid. Først når
  // Entur returnerer tomt (eldre enn det) faller vi tilbake på egne data,
  // se historicalDeps under. Verifisert direkte mot Entur 2026-07-20.
  const { data: depResp, isLoading: depLoading, isError: depError, error: depErr } =
    useQuery<DeparturesResponse>({
      queryKey: [
        `/api/departures/${encodeURIComponent(stopRef ?? "")}?minutes=${minutes}${startIso ? `&startTime=${encodeURIComponent(startIso)}` : ""}${mode === "arrival" ? "&view=arrivals" : ""}`,
      ],
      enabled: stopRef != null,
      refetchInterval: startIso ? false : 60_000,
      placeholderData: keepPreviousData,
    });

  // Entur hadde faktisk rutedata for denne historiske datoen — bruk den
  // (ekte destinasjon, rutetider), bare uten sanntid.
  const enturHistoricalOk = isHistorical && (depResp?.departures?.length ?? 0) > 0;
  // Entur er ferdig og hadde INGENTING for denne datoen (for gammel — se
  // grense over) — da må vi rekonstruere fra egne data, se historicalDeps.
  const enturHistoricalEmpty = isHistorical && !depLoading && (depResp?.departures?.length ?? 0) === 0;

  // Quay-settet ved dette stoppestedet — trengs for å spørre DuckDB, siden
  // Parquet-dataene er lagret på quay-nivå (ikke StopPlace-nivå). Når Entur
  // ga treff for den historiske datoen, bruker vi quay-ene derfra direkte
  // (ingen ekstra kall nødvendig). Bare når Entur var tom trengs en egen
  // "nå"-spørring for å finne quay-settet — NSR StopPlace-IDer slås jevnlig
  // sammen/erstattes, så stop_coords-cachen kan peke på en utdatert ID for
  // samme fysiske sted, mens Entur/SIRI alltid bruker gjeldende quay-IDer.
  const { data: liveForQuays, isLoading: liveQuaysLoading } = useQuery<DeparturesResponse>({
    queryKey: [`/api/departures/${encodeURIComponent(stopRef ?? "")}?minutes=180`],
    enabled: stopRef != null && enturHistoricalEmpty,
    staleTime: 5 * 60_000,
  });

  const quaysForDuck = useMemo(() => {
    const source = enturHistoricalOk ? depResp!.departures : (liveForQuays?.departures ?? []);
    const map = new Map<string, string | null>();
    for (const d of source) if (d.quayRef) map.set(d.quayRef, d.quayName);
    return map;
  }, [enturHistoricalOk, depResp, liveForQuays]);

  // Egne målte data for den historiske datoen — brukes ALLTID når isHistorical
  // (ikke bare som fallback): gir "Faktisk avgang" (den forsinkelsen som
  // faktisk ble registrert den dagen — mer treffsikkert enn Enturs
  // realtime:false for gamle kall) som en berikelse oppå Entur-listen når
  // Entur har treff, og som HELE listen (med "Retning N" i stedet for ekte
  // destinasjon, som ikke finnes i SIRI-dataene) når Entur er tom.
  const { data: historicalDeps = [], isLoading: histLoading } = useQuery<Departure[]>({
    queryKey: ["duck-historical-departures", stopRef ?? "", customDate, customTime, minutes, mode, Array.from(quaysForDuck.keys()).join(",")],
    enabled: isHistorical && duckReady && quaysForDuck.size > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const quayRefs = Array.from(quaysForDuck.keys());

      const timeCol = mode === "arrival" ? "aimed_arrival" : "aimed_departure";
      const fromHM = customTime;
      const end = new Date(`${customDate}T${customTime}:00`);
      end.setMinutes(end.getMinutes() + minutes);
      const toHM = end.toISOString().slice(0, 10) === customDate
        ? `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`
        : "23:59";

      const quayList = quayRefs.map((r) => `'${esc(r)}'`).join(", ");
      const sql = `
        SELECT service_journey_id, line_ref, direction_ref, stop_ref,
               aimed_departure, aimed_arrival, delay_departure_min, delay_arrival_min,
               vehicle_mode
        FROM delays_by_stop
        WHERE date = '${esc(customDate)}'
          AND stop_ref IN (${quayList})
          AND ${timeCol} IS NOT NULL
          AND ${timeCol} >= '${esc(fromHM)}' AND ${timeCol} <= '${esc(toHM)}'
        ORDER BY ${timeCol}
        LIMIT 200`;
      const rows = await duckQuery(sql, undefined, { family: "by-stop", fromDate: customDate, toDate: customDate }) as Array<{
        service_journey_id: string; line_ref: string; direction_ref: string; stop_ref: string;
        aimed_departure: string | null; aimed_arrival: string | null;
        delay_departure_min: number | null; delay_arrival_min: number | null;
        vehicle_mode: string | null;
      }>;

      const iso = (hm: string | null) => (hm ? `${customDate}T${hm}:00` : null);
      return rows.map((r): Departure => {
        const aimedDepIso = iso(r.aimed_departure);
        const aimedArrIso = iso(r.aimed_arrival);
        return {
          aimedTime: aimedDepIso ?? aimedArrIso ?? "",
          expectedTime: aimedDepIso && r.delay_departure_min != null
            ? addMinToIso(aimedDepIso, r.delay_departure_min) : null,
          aimedArrivalTime: aimedArrIso,
          expectedArrivalTime: aimedArrIso && r.delay_arrival_min != null
            ? addMinToIso(aimedArrIso, r.delay_arrival_min) : null,
          realtime: mode === "arrival" ? r.delay_arrival_min != null : r.delay_departure_min != null,
          cancelled: false,
          destination: `Retning ${r.direction_ref}`,
          quayRef: r.stop_ref,
          quayName: quaysForDuck.get(r.stop_ref) ?? null,
          platform: null,
          lineRef: r.line_ref,
          lineNumber: null,
          lineName: null,
          transportMode: r.vehicle_mode,
          serviceJourneyId: r.service_journey_id,
          directionRef: r.direction_ref,
        };
      });
    },
  });

  // Berik Entur-listen med "faktisk avgang" fra egne data (koblet på
  // service_journey_id) når Entur hadde treff for den historiske datoen.
  const enturHistoricalEnriched = useMemo(() => {
    if (!enturHistoricalOk) return [];
    const byId = new Map(historicalDeps.map((r) => [r.serviceJourneyId, r]));
    return depResp!.departures.map((d) => {
      const own = d.serviceJourneyId ? byId.get(d.serviceJourneyId) : undefined;
      return own
        ? { ...d, expectedTime: own.expectedTime, expectedArrivalTime: own.expectedArrivalTime }
        : d;
    });
  }, [enturHistoricalOk, depResp, historicalDeps]);

  const historicalLoading = depLoading || (enturHistoricalEmpty && liveQuaysLoading) || histLoading;

  // Sorter på visningstiden (avgang eller ankomst)
  const departures = useMemo(() => {
    let source: Departure[];
    if (isHistorical) {
      source = enturHistoricalOk ? enturHistoricalEnriched : historicalDeps;
    } else {
      source = depResp?.departures ?? [];
    }
    const list = [...source];
    list.sort(
      (a, b) => new Date(displayTime(a, mode)).getTime() - new Date(displayTime(b, mode)).getTime(),
    );
    return list;
  }, [depResp, historicalDeps, enturHistoricalEnriched, enturHistoricalOk, isHistorical, mode]);

  const duckPairs = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ stopRef: string; lineRef: string }> = [];
    for (const d of departures) {
      if (!d.quayRef || !d.lineRef) continue;
      const k = `${d.quayRef}|${d.lineRef}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ stopRef: d.quayRef, lineRef: d.lineRef });
    }
    return out;
  }, [departures]);

  const { data: delayMap } = useQuery<Map<string, DuckDelayRow>>({
    queryKey: ["duck-departure-delays", ...duckPairs.map(p => `${p.stopRef}|${p.lineRef}`)],
    queryFn: async () => {
      if (duckPairs.length === 0) return new Map();
      const conditions = duckPairs
        .map(p => `(stop_ref = '${esc(p.stopRef)}' AND line_ref = '${esc(p.lineRef)}')`)
        .join(" OR ");
      const sql = `
        SELECT
          stop_ref,
          line_ref,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_departure_min) AS p50_dep,
          PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_departure_min) AS p80_dep,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_departure_min) AS p95_dep,
          COUNT(*) AS n
        FROM delays_by_stop
        WHERE (${conditions}) AND delay_departure_min IS NOT NULL
        GROUP BY stop_ref, line_ref`;
      const rows = await duckQuery(sql, undefined, { family: "by-stop" }) as DuckDelayRow[];
      const map = new Map<string, DuckDelayRow>();
      for (const r of rows) map.set(`${r.stop_ref}|${r.line_ref}`, r);
      return map;
    },
    enabled: duckReady && duckPairs.length > 0,
    staleTime: Infinity,
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-500">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h2 className="text-3xl font-bold tracking-tight flex items-center gap-3">
              <Clock className="w-7 h-7 text-primary" /> Avganger
            </h2>
            <p className="text-muted-foreground mt-1">
              Kommende avganger fra et stoppested, med historisk forsinkelsesstatistikk per linje og stoppested.
            </p>
          </div>
          <RegionSelector />
        </div>

        {/* Stop search */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Søk etter stoppested (f.eks. Bergen busstasjon)…"
                className="pl-9"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setShowResults(true)}
                onBlur={() => setTimeout(() => setShowResults(false), 150)}
              />
              {showResults && searchResults.length > 0 && (
                <div className="absolute top-full mt-1 w-full bg-card border border-border rounded-md shadow-lg z-50 max-h-64 overflow-y-auto">
                  {searchResults.map((r) => {
                    const name = formatStopName(r.stopName, r.stopRef);
                    return (
                      <button
                        key={r.stopRef}
                        className="w-full text-left px-3 py-2 hover:bg-muted text-sm"
                        onMouseDown={() => {
                          setSelectedStop({ ref: r.stopRef, name });
                          setQuery(name);
                          setShowResults(false);
                          // Update URL so refresh + share works
                          navigate(`/avganger?stop=${encodeURIComponent(r.stopRef)}&name=${encodeURIComponent(name)}`);
                        }}
                      >
                        <div className="font-medium">{name}</div>
                        {r.platformCodes && (
                          <div className="text-xs text-muted-foreground">Plattformer: {r.platformCodes}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Time window picker */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm text-muted-foreground">Vis neste:</span>
              <Tabs value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}>
                <TabsList>
                  <TabsTrigger value="30">30 min</TabsTrigger>
                  <TabsTrigger value="60">1 t</TabsTrigger>
                  <TabsTrigger value="90">1,5 t</TabsTrigger>
                  <TabsTrigger value="180">3 t</TabsTrigger>
                </TabsList>
              </Tabs>
              <Tabs value={mode} onValueChange={(v) => setMode(v as "departure" | "arrival")}>
                <TabsList>
                  <TabsTrigger value="departure">Avganger</TabsTrigger>
                  <TabsTrigger value="arrival">Ankomster</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* Tidspunkt-velger: tomt = nå (live). Kan settes frem eller tilbake i tid. */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">Fra tidspunkt:</span>
              <Input
                type="date"
                className="h-9 w-auto text-sm"
                value={customDate}
                onChange={(e) => {
                  setCustomDate(e.target.value);
                  if (e.target.value && !customTime) setCustomTime(nowTime());
                }}
              />
              <Input
                type="time"
                className="h-9 w-auto text-sm"
                value={customTime}
                onChange={(e) => {
                  setCustomTime(e.target.value);
                  if (e.target.value && !customDate) setCustomDate(nowDate());
                }}
              />
              <Button
                variant={startIso ? "outline" : "secondary"}
                size="sm"
                className="h-9"
                disabled={!startIso}
                onClick={() => {
                  setCustomDate("");
                  setCustomTime("");
                }}
              >
                Nå
              </Button>
              {isHistorical && (
                <span className="text-xs text-muted-foreground italic">
                  Historisk dato: rutetider fra Entur når tilgjengelig (~3 dager tilbake), ellers fra
                  egne data. Faktisk avgangstid og P50/P80 er alltid fra egne målte data (siste 90 dager).
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Departure list */}
        {stopRef && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>{(isHistorical ? selectedStop?.name : depResp?.stopName) ?? selectedStop?.name ?? "Avganger"}</span>
                {(isHistorical ? historicalLoading : depLoading) && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
              </CardTitle>
              <CardDescription className="flex items-center gap-1.5">
                <span>
                  {mode === "arrival" ? "Ankomster" : "Avganger"}{" "}
                  {startIso
                    ? `${minutes} min fra ${fmtHM(startIso)} (${customDate})`
                    : `neste ${minutes} minutter • Oppdateres hvert minutt`}
                  {isHistorical
                    ? (!historicalLoading && (enturHistoricalOk
                        ? " • Rutetider fra Entur, faktisk avgang fra egne data"
                        : " • Egne målte data (Entur har ikke rutedata så langt tilbake)"))
                    : (duckReady && delayMap && <span className="ml-2">• Forsinkelsesstatistikk fra DuckDB</span>)}
                </span>
                <InfoTip learnMoreHref="/metode#persentiler">
                  {isHistorical ? (
                    <>
                      <strong>Faktisk avgang</strong> (blå) er forsinkelsen som faktisk ble
                      registrert den dagen. <strong>P50</strong>/<strong>P80</strong> er historiske
                      persentiler for linjen ved stoppet.
                    </>
                  ) : (
                    <>
                      Tallene til høyre: <strong>Sanntid</strong> (faktisk forsinkelse nå) og
                      <strong> P80</strong> (historisk — 4 av 5 ganger har avgangen vært bedre enn dette).
                    </>
                  )}
                </InfoTip>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!isHistorical && depError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 py-4">
                  <AlertCircle className="w-4 h-4" />
                  Kunne ikke laste avganger. {depErr instanceof Error ? depErr.message : ""}
                </div>
              )}

              {(isHistorical ? !historicalLoading : !depError && !depLoading) && departures.length === 0 && (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  {isHistorical
                    ? "Ingen avganger funnet for denne datoen og tidsvinduet, verken fra Entur eller egne data (siste 90 dager)."
                    : "Ingen avganger funnet i tidsvinduet."}
                </p>
              )}

              <div className="divide-y divide-border">
                {departures.map((d, i) => {
                  const rt = realtimeDelayMin(d, mode);
                  const histKey = d.quayRef && d.lineRef ? `${d.quayRef}|${d.lineRef}` : null;
                  const hist = histKey ? delayMap?.get(histKey) : null;
                  const lineNum = lineNumberOf(d);
                  const rowKey = `${d.serviceJourneyId ?? i}-${d.aimedTime}`;
                  const isExpanded = expandedKey === rowKey;
                  // "Faktisk avgang" — den forsinkelsen som faktisk ble registrert
                  // den historiske dagen (fra egne data, se enturHistoricalEnriched
                  // / historicalDeps). Uavhengig av Enturs realtime-flagg, som alltid
                  // er false for gamle kall selv når vi selv har det faktiske utfallet.
                  const actualTime = mode === "arrival" ? d.expectedArrivalTime : d.expectedTime;

                  return (
                    <div key={rowKey}>
                    <div
                      role="button"
                      tabIndex={d.serviceJourneyId ? 0 : -1}
                      onClick={() => {
                        if (d.serviceJourneyId) {
                          setExpandedKey(isExpanded ? null : rowKey);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (d.serviceJourneyId && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          setExpandedKey(isExpanded ? null : rowKey);
                        }
                      }}
                      title="Vis hele reisen med rutetider, sanntid og historiske estimater"
                      className={cn(
                        "w-full grid grid-cols-[auto_auto_1fr_auto_auto] gap-3 items-center py-3 px-1 text-left",
                        "hover:bg-muted/40 transition-colors",
                        d.serviceJourneyId ? "cursor-pointer" : "cursor-default",
                        isExpanded && "bg-muted/30",
                        d.cancelled && "opacity-60 line-through",
                      )}
                    >
                      <div className="font-mono font-bold text-base w-12 tabular-nums">
                        {fmtHM(displayTime(d, mode))}
                      </div>

                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <ModeIcon mode={d.transportMode} size={14} />
                        {d.lineRef ? (
                          <span
                            className="font-mono text-sm hover:underline hover:text-foreground cursor-pointer"
                            title="Se linjeanalyse for denne linjen"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/journey?line=${encodeURIComponent(d.lineRef!)}`);
                            }}
                          >
                            {lineNum}
                          </span>
                        ) : (
                          <span className="font-mono text-sm">{lineNum}</span>
                        )}
                      </div>

                      <div className="text-sm truncate">
                        <span className="text-foreground">{d.destination ?? d.lineName ?? "—"}</span>
                        {d.platform && (
                          <span className="text-xs text-muted-foreground ml-2">Plt. {d.platform}</span>
                        )}
                      </div>

                      {/* Sanntid (live) / Faktisk avgang (historisk) */}
                      {isHistorical ? (
                        actualTime != null ? (
                          <span
                            className="font-mono text-xs text-blue-600 dark:text-blue-400 whitespace-nowrap"
                            title="Faktisk registrert avgangstid denne dagen"
                          >
                            {fmtHM(actualTime)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/60 italic">ukjent</span>
                        )
                      ) : rt != null ? (
                        <Badge variant="outline" className={cn("font-mono text-xs", delayBadgeClass(rt))}>
                          {fmtDeltaMin(rt)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">ingen sanntid</span>
                      )}

                      {/* P50 / P80 */}
                      {hist && (hist.p50_dep != null || hist.p80_dep != null) ? (
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          {hist.p50_dep != null && (
                            <span className="font-mono text-[10px] text-amber-600 dark:text-amber-400" title="Historisk median (P50)">
                              ~{hist.p50_dep > 0 ? "+" : ""}{hist.p50_dep.toFixed(1)}m
                            </span>
                          )}
                          {hist.p80_dep != null && (
                            <Badge variant="outline" className="font-mono text-xs" title="Historisk 80-persentil — 4 av 5 avganger er bedre enn dette">
                              P80 {hist.p80_dep > 0 ? "+" : ""}{hist.p80_dep.toFixed(1)}m
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/60 italic">—</span>
                      )}
                    </div>
                    {isExpanded && d.serviceJourneyId && (
                      <JourneyDetail
                        sjId={d.serviceJourneyId}
                        dateIso={d.aimedTime}
                        lineRef={d.lineRef}
                        highlightQuay={d.quayRef}
                        duckReady={duckReady}
                        duckQuery={duckQuery}
                      />
                    )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stoppstedsanalyse — under avgangslisten, deler samme søk/stopp */}
        {stopRef && selectedStop && (
          <div className="pt-4 space-y-4">
            <div className="border-t border-border pt-6">
              <h3 className="text-2xl font-bold tracking-tight">Stoppstedsanalyse</h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Detaljert forsinkelsesstatistikk for {selectedStop.name}.
              </p>
            </div>
            <StopAnalysisSection stopRef={stopRef} stopName={selectedStop.name} />
          </div>
        )}

        {!stopRef && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              Søk etter et stoppested for å se kommende avganger.
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
