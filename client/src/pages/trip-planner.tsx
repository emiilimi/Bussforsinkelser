import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useParquetQuery, type QueryOptions } from "@/hooks/use-parquet-query";
import { warmupDuckDB } from "@/hooks/use-duckdb";
import Layout from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { useState, useEffect, useRef, useMemo, Fragment } from "react";
import { useLocation, useSearch } from "wouter";
import {
  Navigation, Search, Clock, ArrowRight, AlertTriangle, CheckCircle,
  ArrowDown, ChevronDown, ChevronUp, Footprints, Bus, Train, Ship,
  Accessibility, ArrowDownUp, ArrowUpDown, Plane, Calendar,
  Info, Database, BarChart3, Loader2, Map as MapIcon, LocateFixed, Star,
} from "lucide-react";
import { BusLoading } from "@/components/bus-loading";
import { cn } from "@/lib/utils";
import { computeDayType } from "@/lib/day-type";
import { InfoTip } from "@/components/info-tip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { formatWeekdayDateNO } from "@/lib/date-utils";
import { PlanDelayChart } from "@/components/plan-delay-chart";
import { ServiceJourneyDetail } from "@/components/service-journey-detail";
import { TripRouteMap } from "@/components/trip-route-map";
import {
  getRecentStops, addRecentStop, getFavoriteStops, toggleFavorite,
  getCurrentPositionAsStop,
} from "@/lib/stop-history";
import {
  type TripLeg, type TripPattern, type DuckDelayRow, type StopEntry,
  type StopSearchResult,
  type TransferSpec, type TransferGapResult, type TransferGapObservation,
  type TransferGapSource, type DuckQueryFn,
  legStops, minutesToHM, computeTransferGap, computeTransferGaps,
  probFromGaps, isActualDepartureSource, SPECIFIC_MIN_DAYS,
} from "@/lib/trip-shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TripStopStat = {
  stopRef: string;
  lineRef: string;
  avgDelayMin: number | null;
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  numSamples: number | null;
};

type StatsTimeWindow = {
  type: "all" | "days" | "weekday" | "weekend" | "custom";
  value?: number;
  dateFrom?: string;
  dateTo?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODE_LABELS: Record<string, string> = {
  bus: "Buss",
  tram: "Trikk",
  rail: "Tog",
  metro: "T-bane",
  water: "Bat",
  coach: "Flybuss",
  foot: "Gange",
  bicycle: "Sykkel",
  scooter_rental: "Elsparkesykkel",
};

const MODE_ICONS: Record<string, typeof Bus> = {
  bus: Bus,
  tram: Train,
  rail: Train,
  metro: Train,
  water: Ship,
  coach: Plane,
  foot: Footprints,
};

// Spurt-scenariet: gangtiden regnes om til spurt-tempo, pluss en liten
// sikkerhetsmargin for å komme seg av bussen og i gang.
const SPRINT_MARGIN_SEC = 10;
const SPRINT_MARGIN_MIN = SPRINT_MARGIN_SEC / 60;

// Modes for which the pipeline currently produces delay statistics.
// 'coach' (flybuss) and 'ferry' share the Skyss SIRI ET feed with regular buses.
// ('ferry' is the vehicleMode value Skyss uses — NOT 'water'.)
const MODES_WITH_DELAY_DATA = new Set(["bus", "coach", "ferry"]);

// ---------------------------------------------------------------------------
// DuckDB helpers
// ---------------------------------------------------------------------------

function esc(s: string) { return s.replace(/'/g, "''"); }

type LegTimingSpec = {
  key: string;
  serviceJourneyId: string;
  quayRef: string;
  lineRef: string;
  kind: "dep" | "arr";
  aimedHour: number;
  dayType: string;
};

type LegTimingResult = {
  p50: number | null;
  p80: number | null;
  n: number;
  method: "sj" | "hour1" | "hour2" | "none";
};

// ---------------------------------------------------------------------------
// Empirisk overgangs-suksess: SQL og typer bor nå i lib/trip-shared.ts
// (delt med overgangsanalyse-dialogen og plan-grafene). Selve beregningen kjøres
// sekvensielt for ALLE reiseforslag på sidenivå — se gap-prefetch-effekten i
// TripPlanner.
// ---------------------------------------------------------------------------

/** Build SQL for per-SJ (delta=undefined) or hour-window (delta=1|2) leg timing query.
 *  aimed_departure / aimed_arrival columns in Parquet are "HH:MM:SS" time strings. */
function legTimingSql(s: LegTimingSpec, delta?: number): string {
  const col = s.kind === "dep" ? "delay_departure_min" : "delay_arrival_min";
  const aimedCol = s.kind === "dep" ? "aimed_departure" : "aimed_arrival";
  const where = delta != null
    ? `line_ref = '${esc(s.lineRef)}' AND stop_ref = '${esc(s.quayRef)}'
       AND day_type = '${esc(s.dayType)}'
       AND CAST(SUBSTR(${aimedCol}, 1, 2) AS INTEGER) BETWEEN ${s.aimedHour - delta} AND ${s.aimedHour + delta}`
    : `service_journey_id = '${esc(s.serviceJourneyId)}' AND stop_ref = '${esc(s.quayRef)}'
       AND day_type = '${esc(s.dayType)}'`;
  return `
    SELECT
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${col}) AS p50,
      PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY ${col}) AS p80,
      COUNT(*) AS n
    FROM delays_by_stop WHERE ${where} AND ${col} IS NOT NULL
  `;
}

/** Hook: per-SJ estimated departure/arrival delay with ±1h / ±2h fallback. */
function useEstimatedLegTimes(
  specs: LegTimingSpec[],
  duckReady: boolean,
  duckQuery: (sql: string, params?: unknown[], options?: QueryOptions) => Promise<any[]>,
) {
  return useQuery<Map<string, LegTimingResult>>({
    queryKey: [
      "duck-leg-timing",
      ...specs.map(s => `${s.key}|${s.serviceJourneyId}|${s.quayRef}|${s.kind}|${s.dayType}`),
    ],
    enabled: duckReady && specs.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const out = new Map<string, LegTimingResult>();
      for (const s of specs) {
        const r0 = await duckQuery(legTimingSql(s), undefined, { family: "by-stop" });
        if ((r0[0]?.n ?? 0) >= SPECIFIC_MIN_DAYS) {
          out.set(s.key, { p50: r0[0].p50, p80: r0[0].p80, n: r0[0].n, method: "sj" });
          continue;
        }
        const r1 = await duckQuery(legTimingSql(s, 1), undefined, { family: "by-stop" });
        if ((r1[0]?.n ?? 0) >= SPECIFIC_MIN_DAYS) {
          out.set(s.key, { p50: r1[0].p50, p80: r1[0].p80, n: r1[0].n, method: "hour1" });
          continue;
        }
        const r2 = await duckQuery(legTimingSql(s, 2), undefined, { family: "by-stop" });
        const n2 = r2[0]?.n ?? 0;
        out.set(s.key, { p50: r2[0]?.p50 ?? null, p80: r2[0]?.p80 ?? null, n: n2, method: n2 > 0 ? "hour2" : "none" });
      }
      return out;
    },
  });
}

/** Stabil nøkkel for et reiseforslag — brukes til dedup ved paginering og som React key. */
function patternKey(p: TripPattern): string {
  return `${p.expectedStartTime}|${p.expectedEndTime}|${p.legs
    .map((l) => l.line?.id ?? l.mode)
    .join(",")}`;
}

/** Fjern duplikater (Entur-sider kan overlappe), bevarer rekkefølge. */
function dedupePatterns(patterns: TripPattern[]): TripPattern[] {
  const seen = new Set<string>();
  const out: TripPattern[] = [];
  for (const p of patterns) {
    const key = patternKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** Skyv en "HH:MM:SS"-tid (med dayOffset) deltaMin minutter, håndterer midnatt. */
function shiftTimePart(
  time: string,
  dayOffset: number | null,
  deltaMin: number,
): { time: string; dayOffset: number } {
  const [h, m, s] = time.split(":").map((x) => parseInt(x, 10));
  let total = (h || 0) * 3600 + (m || 0) * 60 + (s || 0) + Math.round(deltaMin * 60);
  let off = dayOffset ?? 0;
  while (total < 0) {
    total += 86400;
    off -= 1;
  }
  while (total >= 86400) {
    total -= 86400;
    off += 1;
  }
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return { time: `${hh}:${mm}:${ss}`, dayOffset: off };
}

/**
 * Lag en ny TripPattern der transit-leg `legIdx` er byttet til en annen avgang
 * av samme linje (newStartIso + newSjId). Kjøretiden antas lik, så hele legget
 * (inkl. passingTimes) skyves med samme delta. Reisens start/slutt flyttes bare
 * hvis det er første/siste transit-legg som byttes.
 */
function shiftPatternLeg(
  pattern: TripPattern,
  legIdx: number,
  newStartIso: string,
  newSjId: string | null,
): TripPattern {
  const leg = pattern.legs[legIdx];
  const deltaMin =
    (new Date(newStartIso).getTime() - new Date(leg.expectedStartTime).getTime()) / 60000;
  if (deltaMin === 0 && (!newSjId || newSjId === leg.serviceJourney?.id)) return pattern;

  const newLeg: TripLeg = {
    ...leg,
    expectedStartTime: addMinutesToIso(leg.expectedStartTime, deltaMin),
    expectedEndTime: addMinutesToIso(leg.expectedEndTime, deltaMin),
    serviceJourney: leg.serviceJourney
      ? {
          id: newSjId ?? leg.serviceJourney.id,
          passingTimes: leg.serviceJourney.passingTimes.map((pt) => ({
            quay: pt.quay,
            departure: pt.departure
              ? { ...pt.departure, ...shiftTimePart(pt.departure.time, pt.departure.dayOffset, deltaMin) }
              : null,
            arrival: pt.arrival
              ? { ...pt.arrival, ...shiftTimePart(pt.arrival.time, pt.arrival.dayOffset, deltaMin) }
              : null,
          })),
        }
      : null,
  };

  const legs = pattern.legs.map((l, i) => (i === legIdx ? newLeg : l));

  const transitIdxs = pattern.legs
    .map((l, i) => (l.mode !== "foot" ? i : -1))
    .filter((i) => i >= 0);
  const isFirstTransit = transitIdxs[0] === legIdx;
  const isLastTransit = transitIdxs[transitIdxs.length - 1] === legIdx;
  const expectedStartTime = isFirstTransit
    ? addMinutesToIso(pattern.expectedStartTime, deltaMin)
    : pattern.expectedStartTime;
  const expectedEndTime = isLastTransit
    ? addMinutesToIso(pattern.expectedEndTime, deltaMin)
    : pattern.expectedEndTime;
  const duration =
    (new Date(expectedEndTime).getTime() - new Date(expectedStartTime).getTime()) / 1000;

  return { ...pattern, legs, expectedStartTime, expectedEndTime, duration };
}

/**
 * Bygg TransferSpec-liste for et reiseforslag (én per transit→transit-bytte).
 * day_type tas fra reisens planlagte avreisedato slik at f.eks. en onsdagsreise
 * bare henter hverdagsobservasjoner fra Parquet.
 */
function buildTransferSpecsForPattern(pattern: TripPattern): TransferSpec[] {
  const tripDayType = computeDayType(pattern.expectedStartTime);

  // Aimed (scheduled) HH:MM at a quay from a leg's serviceJourney.passingTimes.
  // Returns minutes-since-midnight, or null when missing.
  const aimedMinAtQuay = (leg: TripLeg, quayId: string | null, kind: "arrival" | "departure"): number | null => {
    if (!quayId || !leg.serviceJourney) return null;
    const pt = leg.serviceJourney.passingTimes.find(p => p.quay?.id === quayId);
    const t = kind === "arrival" ? pt?.arrival?.time : pt?.departure?.time;
    if (!t) return null;
    const [hh, mm] = t.split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return hh * 60 + mm;
  };

  const transitIdxs: number[] = [];
  for (let i = 0; i < pattern.legs.length; i++) {
    if (pattern.legs[i].mode !== "foot") transitIdxs.push(i);
  }
  const out: TransferSpec[] = [];
  for (let t = 0; t < transitIdxs.length - 1; t++) {
    const legA = pattern.legs[transitIdxs[t]];
    const legB = pattern.legs[transitIdxs[t + 1]];
    const arrQuay = legA.toPlace.quay?.id ?? null;
    const depQuay = legB.fromPlace.quay?.id ?? null;
    out.push({
      key: `t${t}`,
      arrSjId: legA.serviceJourney?.id ?? null,
      arrQuayRef: arrQuay,
      arrLineRef: legA.line?.id ?? null,
      arrAimedMin: aimedMinAtQuay(legA, arrQuay, "arrival"),
      depSjId: legB.serviceJourney?.id ?? null,
      depQuayRef: depQuay,
      depLineRef: legB.line?.id ?? null,
      depAimedMin: aimedMinAtQuay(legB, depQuay, "departure"),
      dayType: tripDayType,
    });
  }
  return out;
}

/** Gangtid (minutter) mellom hvert transit→transit-bytte i et reiseforslag. */
function transferWalkTimes(pattern: TripPattern): number[] {
  const transitIdxs: number[] = [];
  for (let i = 0; i < pattern.legs.length; i++) {
    if (pattern.legs[i].mode !== "foot") transitIdxs.push(i);
  }
  const out: number[] = [];
  for (let t = 0; t < transitIdxs.length - 1; t++) {
    let sec = 0;
    for (let k = transitIdxs[t] + 1; k < transitIdxs[t + 1]; k++) {
      if (pattern.legs[k].mode === "foot") sec += pattern.legs[k].duration ?? 0;
    }
    out.push(sec / 60);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan B/C/D — fallback-kjede når en overgang kan ryke
//
// Hvis P(miste overgang) ≥ 5 %: søk en ny reise fra overgangsstoppet til
// destinasjonen, med avreise = realistisk ankomst hvis du mister bussen
// (planlagt ankomst + P80-forsinkelse + gangtid). Hver fallback-plan får sin
// egen empiriske overgangssannsynlighet, og kjeden fortsetter (plan C, D...)
// til sannsynligheten for å trenge neste plan er under 5 %.
//
// Forenkling (dokumentert i /metode): plan C søkes fra samme overgangsstopp
// som plan B (første avgang etter plan B), ikke fra plan Bs eventuelle egne
// overgangsstopp. Dette dekker det vanlige tilfellet der fallback = neste
// avgang(er) fra stoppet du står på.
// ---------------------------------------------------------------------------

const FALLBACK_PROB_FLOOR = 0.05; // stopp kjeden når P(trenger neste plan) < 5 %
const FALLBACK_MAX_DEPTH = 4;

type FallbackStep = {
  pattern: TripPattern;
  needProb: number;             // P(du trenger denne planen)
  makeProb: number;             // P(planens egne overganger går) — 1 hvis direkte
  daysObservedMin: number | null; // minste datagrunnlag blant planens overganger
  isWalk: boolean;              // ren gange (deterministisk — avslutter kjeden)
  // Vises kun som alternativ (f.eks. buss når gange er raskest) —
  // teller IKKE med i forventet ankomst.
  altOnly: boolean;
};

/** Er reiseforslaget ren gange (ingen transit-legg)? */
function isWalkOnlyPattern(p: TripPattern): boolean {
  return p.legs.length > 0 && p.legs.every((l) => l.mode === "foot");
}

/** Første transit-leggs serviceJourney-id i et reiseforslag. */
function firstTransitSjId(p: TripPattern): string | null {
  const leg = p.legs.find((l) => l.mode !== "foot");
  return leg?.serviceJourney?.id ?? null;
}

function useFallbackChain(opts: {
  enabled: boolean;
  transferQuayId: string | null;
  destination: Record<string, unknown> | null;
  missProb: number;
  missArrivalIso: string | null;
  /** Avgangen du kan miste: plan B må gå ETTER denne (ellers er den plan A). */
  missedDepartureIso: string | null;
  missedSjId: string | null;
  selectedModes: string[];
  walkSpeedKmh: number;
  transferMarginMin: number;
  duckReady: boolean;
  duckQuery: DuckQueryFn;
}) {
  const {
    enabled, transferQuayId, destination, missProb, missArrivalIso,
    missedDepartureIso, missedSjId,
    selectedModes, walkSpeedKmh, transferMarginMin, duckReady, duckQuery,
  } = opts;

  return useQuery<FallbackStep[]>({
    queryKey: [
      "fallback-chain",
      transferQuayId,
      JSON.stringify(destination),
      missArrivalIso,
      missedDepartureIso,
      missedSjId,
      missProb.toFixed(3),
      transferMarginMin,
      selectedModes.join(","),
    ],
    enabled:
      enabled &&
      !!transferQuayId &&
      !!destination &&
      !!missArrivalIso &&
      missProb >= FALLBACK_PROB_FLOOR,
    staleTime: Infinity,
    queryFn: async () => {
      const steps: FallbackStep[] = [];
      let needProb = missProb;
      // "Du mistet bussen" betyr at den gikk før du rakk den — plan B må derfor
      // gå strengt etter den mistede avgangen, uansett hvor tidlig P80-anslaget
      // sier at du står på stoppet. Ellers finner Entur samme buss som plan A.
      const missedDepMs = missedDepartureIso ? new Date(missedDepartureIso).getTime() : 0;
      let searchFrom = new Date(
        Math.max(new Date(missArrivalIso!).getTime(), missedDepMs + 60_000),
      ).toISOString();
      // SJ-ider som allerede er brukt (planen du mister + tidligere fallbacks)
      const usedSjIds = new Set<string>(missedSjId ? [missedSjId] : []);

      // Planens egen overgangsrisiko — samme empiriske metode som hovedplanen
      const analyzePattern = async (
        pattern: TripPattern,
      ): Promise<{ makeProb: number; daysMin: number | null }> => {
        let makeProb = 1;
        let daysMin: number | null = null;
        if (!duckReady) return { makeProb, daysMin };
        const specs = buildTransferSpecsForPattern(pattern);
        const walks = transferWalkTimes(pattern);
        for (let t = 0; t < specs.length; t++) {
          let gaps: number[] = [];
          try {
            gaps = (await computeTransferGap(specs[t], duckQuery)).gaps;
          } catch { /* ignorér — behandles som manglende data */ }
          if (gaps.length > 0) {
            const p = probFromGaps(gaps, (walks[t] ?? 0) + transferMarginMin);
            makeProb *= Math.max(0, p);
            daysMin = daysMin == null ? gaps.length : Math.min(daysMin, gaps.length);
          }
          // Uten data antar vi at overgangen går (makeProb uendret) — vises i UI
        }
        return { makeProb, daysMin };
      };

      // Gange hentes separat hvis hovedsøket ikke tilbyr det: Entur filtrerer
      // bort gåturer over ca. en halvtime når det finnes buss — men brukeren
      // skal alltid få gange vurdert (med sin egen ganghastighet). Et søk uten
      // tilgjengelige transportmidler (air) + directMode: foot gir ren gange
      // med reell gåruteberegning. Gange er tidsuavhengig, så vi henter én
      // gang og skyver tidene til hvert søketidspunkt.
      let walkTemplate: TripPattern | null = null;
      let walkFetched = false;
      const getWalkPattern = async (fromIso: string): Promise<TripPattern | null> => {
        if (!walkFetched) {
          walkFetched = true;
          try {
            const res = await apiRequest("POST", "/api/trip", {
              from: { place: transferQuayId },
              to: destination,
              when: fromIso,
              transportModes: ["air"],
              directMode: "foot",
              walkSpeed: walkSpeedKmh / 3.6,
              numTripPatterns: 1,
            });
            const d = await res.json();
            const pats: TripPattern[] = d?.data?.trip?.tripPatterns ?? [];
            walkTemplate = pats.find(isWalkOnlyPattern) ?? null;
          } catch {
            walkTemplate = null;
          }
        }
        if (!walkTemplate) return null;
        const delta =
          (new Date(fromIso).getTime() - new Date(walkTemplate.expectedStartTime).getTime()) /
          60000;
        if (Math.abs(delta) < 0.5) return walkTemplate;
        return {
          ...walkTemplate,
          expectedStartTime: addMinutesToIso(walkTemplate.expectedStartTime, delta),
          expectedEndTime: addMinutesToIso(walkTemplate.expectedEndTime, delta),
          legs: walkTemplate.legs.map((l) => ({
            ...l,
            expectedStartTime: addMinutesToIso(l.expectedStartTime, delta),
            expectedEndTime: addMinutesToIso(l.expectedEndTime, delta),
          })),
        };
      };

      for (let depth = 0; depth < FALLBACK_MAX_DEPTH && needProb >= FALLBACK_PROB_FLOOR; depth++) {
        const res = await apiRequest("POST", "/api/trip", {
          from: { place: transferQuayId },
          to: destination,
          when: searchFrom,
          transportModes: selectedModes.length > 0 ? selectedModes : undefined,
          walkSpeed: walkSpeedKmh / 3.6,
          // directMode: foot → Entur returnerer også ren gange som alternativ
          directMode: "foot",
          numTripPatterns: 5,
        });
        const data = await res.json();
        const patterns: TripPattern[] = data?.data?.trip?.tripPatterns ?? [];
        // Kandidater: ikke en avgang vi allerede har regnet med (samme
        // serviceJourney = samme buss), helst med start etter søketidspunktet.
        const searchFromMs = new Date(searchFrom).getTime();
        const usable = patterns.filter((p) => {
          const sj = firstTransitSjId(p);
          return sj == null || !usedSjIds.has(sj);
        });
        const walkPattern =
          (usable.find(isWalkOnlyPattern) ?? null) || (await getWalkPattern(searchFrom));
        const busCandidates = usable.filter((p) => !isWalkOnlyPattern(p));
        const busPattern =
          busCandidates.find((p) => new Date(p.expectedStartTime).getTime() >= searchFromMs) ??
          busCandidates[0] ??
          null;

        // Er ren gange raskest? Da er den planen (deterministisk — ingen
        // videre kjede), men bussen vises fortsatt som alternativ for de som
        // heller vil vente enn å gå.
        if (
          walkPattern &&
          (!busPattern ||
            new Date(walkPattern.expectedEndTime).getTime() <=
              new Date(busPattern.expectedEndTime).getTime())
        ) {
          steps.push({
            pattern: walkPattern,
            needProb,
            makeProb: 1,
            daysObservedMin: null,
            isWalk: true,
            altOnly: false,
          });
          if (busPattern) {
            const { makeProb, daysMin } = await analyzePattern(busPattern);
            steps.push({
              pattern: busPattern,
              needProb,
              makeProb,
              daysObservedMin: daysMin,
              isWalk: false,
              altOnly: true,
            });
          }
          break;
        }

        if (!busPattern) break;
        const usedSj = firstTransitSjId(busPattern);
        if (usedSj) usedSjIds.add(usedSj);

        const { makeProb, daysMin } = await analyzePattern(busPattern);
        steps.push({
          pattern: busPattern,
          needProb,
          makeProb,
          daysObservedMin: daysMin,
          isWalk: false,
          altOnly: false,
        });
        needProb = needProb * (1 - makeProb);
        // Neste plan: første avgang etter denne planens avgang fra samme stopp
        searchFrom = addMinutesToIso(busPattern.expectedStartTime, 1);
      }
      return steps;
    },
  });
}

/** Hook: fetch delay distributions from DuckDB for trip (stop, line) pairs */
function useTripDelayDistribution(
  pairs: Array<{ stopRef: string; lineRef: string }>,
  duckReady: boolean,
  duckQuery: (sql: string, params?: unknown[], options?: QueryOptions) => Promise<any[]>,
) {
  return useQuery<Map<string, DuckDelayRow>>({
    queryKey: ["duck-trip-delays", ...pairs.map(p => `${p.stopRef}|${p.lineRef}`)],
    queryFn: async () => {
      if (pairs.length === 0) return new Map();

      const conditions = pairs
        .map(p => `(stop_ref = '${esc(p.stopRef)}' AND line_ref = '${esc(p.lineRef)}')`)
        .join(" OR ");

      const sql = `
        SELECT
          stop_ref,
          line_ref,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_departure_min) AS p50_dep,
          PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_departure_min) AS p80_dep,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_departure_min) AS p95_dep,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_arrival_min) AS p50_arr,
          PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_arrival_min) AS p80_arr,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_arrival_min) AS p95_arr,
          COUNT(*) AS n
        FROM delays_by_stop
        WHERE (${conditions})
          AND (delay_departure_min IS NOT NULL OR delay_arrival_min IS NOT NULL)
        GROUP BY stop_ref, line_ref
      `;

      const rows = await duckQuery(sql, undefined, { family: "by-stop" }) as DuckDelayRow[];
      const map = new Map<string, DuckDelayRow>();
      for (const row of rows) {
        map.set(`${row.stop_ref}|${row.line_ref}`, row);
      }
      return map;
    },
    enabled: duckReady && pairs.length > 0,
    staleTime: Infinity,
  });
}

const TRANSPORT_MODE_OPTIONS = [
  { value: "bus", label: "Buss" },
  { value: "tram", label: "Trikk" },
  { value: "rail", label: "Tog" },
  { value: "metro", label: "T-bane" },
  { value: "water", label: "Bat/ferje" },
  { value: "coach", label: "Flybuss" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}t ${m % 60}min`;
}

function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

function ModeIcon({ mode, className }: { mode: string; className?: string }) {
  const Icon = MODE_ICONS[mode] ?? Bus;
  return <Icon className={className} />;
}

function delayBadge(delay: number | null, hasData: boolean) {
  if (!hasData) return <Badge variant="outline" className="text-muted-foreground/50 border-dashed text-[9px]">ingen data</Badge>;
  if (delay == null) return null;
  if (Math.abs(delay) < 1) return <Badge variant="outline" className="text-green-600 border-green-300 text-[10px]">i rute</Badge>;
  if (delay < 3) return <Badge variant="outline" className="text-amber-600 border-amber-300 text-[10px]">+{delay.toFixed(1)}m</Badge>;
  return <Badge variant="destructive" className="text-[10px]">+{delay.toFixed(1)}m</Badge>;
}

function probabilityBadge(prob: number) {
  const pct = Math.round(prob * 100);
  if (prob > 0.90) {
    return <Badge variant="outline" className="text-green-600 border-green-300 text-[10px]">{pct}%</Badge>;
  }
  if (prob > 0.60) {
    return <Badge variant="outline" className="text-amber-600 border-amber-300 text-[10px]">{pct}%</Badge>;
  }
  return <Badge variant="destructive" className="text-[10px]">{pct}%</Badge>;
}

function addMinutesToIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d.toISOString();
}

function legTimingTooltip(r: LegTimingResult): string {
  if (r.method === "sj") return `Median av ${r.n} avganger med samme rute-ID`;
  if (r.method === "hour1") return `Median av ${r.n} avganger ±1 time (for få treff på eksakt avgang)`;
  if (r.method === "hour2") return `Median av ${r.n} avganger ±2 timer (utvidet søk)`;
  return "Ingen historisk data";
}

function estimateP80(avgDelay: number | null, realP80?: number | null): string | null {
  // Use real DuckDB P80 if available
  if (realP80 != null) {
    if (Math.abs(realP80) < 1) return "i rute";
    return `+${realP80.toFixed(1)}m`;
  }
  if (avgDelay == null) return null;
  if (avgDelay < 1) return "i rute";
  const p80est = avgDelay * 1.5;
  return `~+${p80est.toFixed(1)}m`;
}

/** Round to nearest 5 minutes for time input */
function roundedNow(): string {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Geocoder result type
// ---------------------------------------------------------------------------

type GeocoderResult = {
  id: string;
  name: string;
  label: string;
  layer: string;
  lat: number;
  lng: number;
};

// ---------------------------------------------------------------------------
// Stop / address search with debounce — uses Entur Geocoder API
// ---------------------------------------------------------------------------

function StopSearch({
  label,
  value,
  onSelect,
  externalQuery,
}: {
  label: string;
  value: StopSearchResult | null;
  onSelect: (stop: StopSearchResult) => void;
  externalQuery?: string;
}) {
  const [query, setQuery] = useState(value?.stopName ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Favoritter/nylige leses ved åpning (ikke ved hver tast) — de endres bare
  // som følge av brukerens egne klikk, som vi selv oppdaterer state for.
  const [favorites, setFavorites] = useState<StopSearchResult[]>([]);
  const [recents, setRecents] = useState<StopSearchResult[]>([]);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFavorites(getFavoriteStops());
      setRecents(getRecentStops());
    }
  }, [open]);

  /** Felles utvelgelse: lukk, fyll inn navn, husk i historikk, meld oppover. */
  function choose(stop: StopSearchResult) {
    setQuery(stop.stopName);
    setOpen(false);
    setLocError(null);
    addRecentStop(stop);
    onSelect(stop);
  }

  async function useMyPosition() {
    setLocating(true);
    setLocError(null);
    try {
      choose(await getCurrentPositionAsStop());
    } catch (e) {
      setLocError(e instanceof Error ? e.message : "Kunne ikke hente posisjonen din.");
    } finally {
      setLocating(false);
    }
  }

  // Sync query when value changes externally (e.g. swap direction)
  useEffect(() => {
    if (externalQuery !== undefined) {
      setQuery(externalQuery);
    }
  }, [externalQuery]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results = [] } = useQuery<GeocoderResult[]>({
    queryKey: [`/api/geocoder/autocomplete?text=${encodeURIComponent(debouncedQuery)}&size=8`],
    enabled: debouncedQuery.length >= 2 && open,
  });

  function toStopSearchResult(r: GeocoderResult): StopSearchResult {
    // "venue" layer = NSR stop (StopPlace or Quay)
    const isStop = r.layer === "venue" && r.id.startsWith("NSR:");
    return {
      stopRef: isStop ? r.id : `coords:${r.lat},${r.lng}`,
      stopPlaceRef: isStop ? r.id : null,
      stopName: r.name,
      label: r.label,
      layer: r.layer,
      lat: r.lat,
      lng: r.lng,
    };
  }

  const layerIcon = (layer: string) => {
    if (layer === "venue") return "\u{1F68F}"; // bus stop emoji
    return "\u{1F4CD}"; // pin emoji
  };

  return (
    <div className="relative">
      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          placeholder="Stoppested eller adresse..."
          className="pl-9"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
        />
      </div>
      {/* Viser hvor "Min posisjon" faktisk ble tolket til å være, slik at en
          unøyaktig posisjon er synlig med det samme (ikke bare den opake
          teksten "Min posisjon"). */}
      {!open && value?.layer === "position" && value.label && value.label !== value.stopName && (
        <p className="mt-1 text-[11px] text-muted-foreground flex items-center gap-1 leading-snug">
          <LocateFixed className="h-3 w-3 flex-shrink-0" />
          {value.label}
        </p>
      )}
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {/* Min posisjon — alltid øverst */}
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-center gap-2 disabled:opacity-60"
            disabled={locating}
            onMouseDown={(e) => { e.preventDefault(); void useMyPosition(); }}
          >
            {locating
              ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary flex-shrink-0" />
              : <LocateFixed className="h-3.5 w-3.5 text-primary flex-shrink-0" />}
            <span className="text-primary font-medium">
              {locating ? "Finner posisjonen din…" : "Min posisjon"}
            </span>
          </button>
          {locError && (
            <p className="px-3 pb-2 text-[11px] text-destructive leading-snug">{locError}</p>
          )}

          {/* Søketreff når man har skrevet noe; ellers favoritter + nylige */}
          {debouncedQuery.length >= 2 ? (
            results.length > 0 ? (
              <>
                <SectionLabel>Søketreff</SectionLabel>
                {results.map((r) => {
                  const stop = toStopSearchResult(r);
                  return (
                    <StopRow
                      key={r.id}
                      icon={<span className="text-xs">{layerIcon(r.layer)}</span>}
                      title={r.name}
                      subtitle={r.label !== r.name ? r.label : undefined}
                      isFav={favorites.some((f) => f.stopRef === stop.stopRef)}
                      onPick={() => choose(stop)}
                      onToggleFav={() => setFavorites(toggleFavorite(stop))}
                    />
                  );
                })}
              </>
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">Ingen treff.</p>
            )
          ) : (
            <>
              {favorites.length > 0 && (
                <>
                  <SectionLabel>Favoritter</SectionLabel>
                  {favorites.map((s) => (
                    <StopRow
                      key={`fav-${s.stopRef}`}
                      icon={<Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
                      title={s.stopName}
                      subtitle={s.label !== s.stopName ? s.label : undefined}
                      isFav
                      onPick={() => choose(s)}
                      onToggleFav={() => setFavorites(toggleFavorite(s))}
                    />
                  ))}
                </>
              )}
              {recents.length > 0 && (
                <>
                  <SectionLabel>Nylig søkt</SectionLabel>
                  {recents.map((s) => (
                    <StopRow
                      key={`rec-${s.stopRef}`}
                      icon={<Clock className="h-3.5 w-3.5 text-muted-foreground" />}
                      title={s.stopName}
                      subtitle={s.label !== s.stopName ? s.label : undefined}
                      isFav={favorites.some((f) => f.stopRef === s.stopRef)}
                      onPick={() => choose(s)}
                      onToggleFav={() => setFavorites(toggleFavorite(s))}
                    />
                  ))}
                </>
              )}
              {favorites.length === 0 && recents.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground leading-snug">
                  Skriv for å søke etter stoppested eller adresse. Steder du velger
                  havner her, og du kan stjernemerke favoritter.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </p>
  );
}

/** Én rad i søkelista: velg stedet, eller slå favoritt av/på med stjernen. */
function StopRow({
  icon, title, subtitle, isFav, onPick, onToggleFav,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  isFav: boolean;
  onPick: () => void;
  onToggleFav: () => void;
}) {
  return (
    <div className="flex items-center hover:bg-muted/50 transition-colors">
      <button
        className="flex-1 min-w-0 text-left px-3 py-2 text-sm flex items-start gap-2"
        onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      >
        <span className="mt-0.5 flex-shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="block truncate">{title}</span>
          {subtitle && (
            <span className="block text-xs text-muted-foreground truncate">{subtitle}</span>
          )}
        </span>
      </button>
      <button
        className="px-2 py-2 flex-shrink-0"
        title={isFav ? "Fjern favoritt" : "Lagre som favoritt"}
        aria-label={isFav ? "Fjern favoritt" : "Lagre som favoritt"}
        onMouseDown={(e) => { e.preventDefault(); onToggleFav(); }}
      >
        <Star
          className={cn(
            "h-3.5 w-3.5 transition-colors",
            isFav ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40 hover:text-amber-400",
          )}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-leg alternative departures ("Bytt avgang" — som på entur.no)
// ---------------------------------------------------------------------------

type AltDepartureRaw = {
  aimedTime: string | null;
  expectedTime: string | null;
  cancelled: boolean;
  destination: string | null;
  lineRef: string | null;
  serviceJourneyId: string | null;
};

function LegAlternatives({
  pattern,
  legIdx,
  onSelect,
}: {
  pattern: TripPattern;
  legIdx: number;
  onSelect: (newStartIso: string, sjId: string | null) => void;
}) {
  const leg = pattern.legs[legIdx];
  const quayId = leg.fromPlace.quay?.id ?? null;
  const lineRef = leg.line?.id ?? null;

  // Hent avganger i et vindu rundt nåværende avgang: 90 min før → 210 min etter.
  const windowStartIso = useMemo(
    () => new Date(new Date(leg.expectedStartTime).getTime() - 90 * 60000).toISOString(),
    [leg.expectedStartTime],
  );
  const url = quayId
    ? `/api/departures/${encodeURIComponent(quayId)}?startTime=${encodeURIComponent(windowStartIso)}&minutes=300&limit=100`
    : null;
  const { data, isLoading, isError } = useQuery<{ departures: AltDepartureRaw[] }>({
    queryKey: [url ?? "alt-dep-disabled"],
    enabled: !!url,
  });

  // Gjennomførbarhet mot nabo-leggene (gangtid mellom transit-legg er foot-legg).
  const constraints = useMemo(() => {
    const transitIdxs: number[] = [];
    for (let i = 0; i < pattern.legs.length; i++) {
      if (pattern.legs[i].mode !== "foot") transitIdxs.push(i);
    }
    const pos = transitIdxs.indexOf(legIdx);
    const walkSecBetween = (a: number, b: number) => {
      let s = 0;
      for (let k = a + 1; k < b; k++) {
        if (pattern.legs[k].mode === "foot") s += pattern.legs[k].duration ?? 0;
      }
      return s;
    };
    const prevIdx = pos > 0 ? transitIdxs[pos - 1] : null;
    const nextIdx = pos >= 0 && pos < transitIdxs.length - 1 ? transitIdxs[pos + 1] : null;
    return {
      // Tidligste mulige avgang: forrige buss' ankomst + gangtid
      earliestStartMs:
        prevIdx != null
          ? new Date(pattern.legs[prevIdx].expectedEndTime).getTime() +
            walkSecBetween(prevIdx, legIdx) * 1000
          : null,
      // Seneste mulige ankomst: neste buss' avgang − gangtid
      latestEndMs:
        nextIdx != null
          ? new Date(pattern.legs[nextIdx].expectedStartTime).getTime() -
            walkSecBetween(legIdx, nextIdx) * 1000
          : null,
    };
  }, [pattern, legIdx]);

  const candidates = useMemo(() => {
    const curStartMs = new Date(leg.expectedStartTime).getTime();
    const seen = new Set<string>();
    const out: Array<
      AltDepartureRaw & {
        timeMs: number;
        deltaMin: number;
        isCurrent: boolean;
        tooEarly: boolean;
        missesNext: boolean;
      }
    > = [];
    for (const d of data?.departures ?? []) {
      if (d.lineRef !== lineRef || d.cancelled || !d.aimedTime) continue;
      const key = d.serviceJourneyId ?? d.aimedTime;
      if (seen.has(key)) continue;
      seen.add(key);
      const timeMs = new Date(d.aimedTime).getTime();
      const endMs = timeMs + (leg.duration ?? 0) * 1000;
      out.push({
        ...d,
        timeMs,
        deltaMin: Math.round((timeMs - curStartMs) / 60000),
        isCurrent:
          Math.abs(timeMs - curStartMs) < 30_000 ||
          d.serviceJourneyId === leg.serviceJourney?.id,
        tooEarly: constraints.earliestStartMs != null && timeMs < constraints.earliestStartMs,
        missesNext: constraints.latestEndMs != null && endMs > constraints.latestEndMs,
      });
    }
    out.sort((a, b) => a.timeMs - b.timeMs);
    // Vis maks 5 før + 5 etter valgt avgang
    const curPos = out.findIndex((c) => c.isCurrent);
    const anchor = curPos < 0 ? 0 : curPos;
    return out.slice(Math.max(0, anchor - 5), Math.min(out.length, anchor + 6));
  }, [data, lineRef, leg, constraints]);

  if (!quayId || !lineRef) return null;

  return (
    <div className="mt-2 ml-2 border-l-2 border-primary/20 pl-3 space-y-1">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
        Andre avganger — linje {leg.line?.publicCode} fra {leg.fromPlace.quay?.name ?? leg.fromPlace.name}
      </p>
      {isLoading && <p className="text-xs text-muted-foreground">Henter avganger...</p>}
      {isError && <p className="text-xs text-destructive">Kunne ikke hente avganger.</p>}
      {!isLoading && !isError && candidates.length === 0 && (
        <p className="text-xs text-muted-foreground">Fant ingen andre avganger i tidsvinduet (±1,5–3,5 t).</p>
      )}
      {candidates.map((c) => (
        <button
          key={c.serviceJourneyId ?? c.aimedTime!}
          disabled={c.isCurrent || c.tooEarly}
          onClick={() => onSelect(new Date(c.timeMs).toISOString(), c.serviceJourneyId)}
          className={cn(
            "w-full flex items-center gap-2 text-xs rounded px-2 py-1 text-left transition-colors",
            c.isCurrent
              ? "bg-primary/10 font-medium cursor-default"
              : c.tooEarly
                ? "opacity-40 cursor-not-allowed"
                : "hover:bg-muted cursor-pointer",
          )}
        >
          <span className="font-mono tabular-nums">{formatTime(c.aimedTime!)}</span>
          <span className="text-muted-foreground font-mono text-[10px] w-14">
            {c.deltaMin === 0 ? "" : c.deltaMin > 0 ? `+${c.deltaMin} min` : `${c.deltaMin} min`}
          </span>
          <span className="text-muted-foreground truncate flex-1">{c.destination}</span>
          {c.isCurrent && (
            <Badge variant="outline" className="text-[9px] border-primary/40 text-primary">valgt</Badge>
          )}
          {c.tooEarly && !c.isCurrent && (
            <span className="text-[9px] text-muted-foreground italic">rekker ikke fra forrige buss</span>
          )}
          {c.missesNext && !c.tooEarly && !c.isCurrent && (
            <span className="text-[9px] text-red-500 flex items-center gap-0.5">
              <AlertTriangle className="h-2.5 w-2.5" />
              rekker ikke neste buss
            </span>
          )}
        </button>
      ))}
      <p className="text-[9px] text-muted-foreground/60 italic">
        Ankomsttid antas lik kjøretid som opprinnelig avgang. Bytte av midtre legg kan
        bryte overganger — dette flagges i rødt.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan B/C/D-visning under en risikabel overgang
// ---------------------------------------------------------------------------

const PLAN_LETTERS = ["B", "C", "D", "E"];

// Legg med flere stopp enn dette kollapses til første + siste stopp
const STOP_COLLAPSE_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// Overgangsinfo per transit→transit-bytte (beregnet i TripCard, vist både i
// den kompakte inline-raden og i overgangsanalyse-dialogen)
// ---------------------------------------------------------------------------

type TransferProbs = { default: number; user: number; sprint: number };

type TransferInfo = {
  buffer: number;         // totalt planlagt gap (minutter)
  walkTime: number;       // gangtid mellom A og B (minutter)
  sprintWalkTime: number; // gangtid skalert til spurt-tempo
  probs: TransferProbs;   // 3 empiriske sannsynligheter, -1 = ukjent
  daysObserved: number;   // antall historiske dager gapet er observert
  source: TransferGapSource;
  fromLine: string | null;
  toLine: string | null;
  assumingOnTime: boolean;
  // true når planlagt gap < gangtid — overgangen er umulig selv uten
  // forsinkelse (oppstår typisk etter manuelt bytte av avgang på et legg)
  broken: boolean;
  observations: TransferGapObservation[]; // per-dag-observasjoner, nyeste først
  /** Begge sporene vises side om side i overgangsanalysen, slik at man alltid ser
   *  hvor mange dager estimatet for DIN avgang faktisk bygger på. */
  actual: { days: number; source: "sj" | "aimed" | "none"; probs: TransferProbs };
  pool: { days: number; probs: TransferProbs };
};

const OBSERVATION_TABLE_LIMIT = 10;

/** Overgangsanalyse-dialog for én overgang: de tre sannsynlighetene, datakilde,
 *  og ("Vis data") de siste faktiske forekomstene av overgangen — samme idé
 *  som enkeltavgangs-tabellen i stoppanalysen. */
function TransferAnalysisDialog({
  info,
  transferMarginMin,
  sprintSpeedKmh,
  isPending,
  onClose,
}: {
  info: TransferInfo;
  transferMarginMin: number;
  sprintSpeedKmh: number;
  /** true = sidenivå-prefetchen har ikke nådd dette reiseforslaget ennå.
   *  Uten denne kunne dialogen feilaktig vise "mangler forsinkelsesdata" for
   *  en overgang som faktisk bare ikke er ferdig beregnet ennå. */
  isPending: boolean;
  onClose: () => void;
}) {
  const [showData, setShowData] = useState(false);
  const rows = info.observations.slice(0, OBSERVATION_TABLE_LIMIT);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            Overgangsanalyse
            {info.fromLine && info.toLine && <> linje {info.fromLine} → {info.toLine}</>}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Planlagt margin {(info.buffer - info.walkTime).toFixed(1)} min
            {info.walkTime > 0 ? (
              <> utover gange ({info.walkTime.toFixed(1)} min) — {info.buffer.toFixed(0)} min gap totalt.</>
            ) : (
              <> (ingen gange nødvendig).</>
            )}{" "}
            Sannsynlighetene telles opp dag for dag i historikken — ingen simulering.
          </DialogDescription>
        </DialogHeader>

        {info.probs.default >= 0 ? (
          <div className="flex flex-col gap-1 text-xs">
            {/* Begge estimatene side om side, med datagrunnlag i overskriften */}
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1 items-center">
              <span />
              <span className="text-[10px] text-center leading-tight">
                <span className="font-medium">Din avgang</span>
                <span className="block text-muted-foreground/70">
                  {info.actual.days > 0 ? `${info.actual.days} dager` : "ingen"}
                </span>
              </span>
              <span className="text-[10px] text-center leading-tight">
                <span className="font-medium">Sammenlign&shy;bare</span>
                <span className="block text-muted-foreground/70">
                  {info.pool.days > 0 ? `${info.pool.days} dager` : "ingen"}
                </span>
              </span>

              {([
                ["Med 2 min margin:", "default"],
                [`Med ${transferMarginMin} min margin:`, "user"],
                [`Spurt (${sprintSpeedKmh.toFixed(1)} km/t + ${SPRINT_MARGIN_SEC} sek):`, "sprint"],
              ] as const).map(([label, key]) => (
                <Fragment key={key}>
                  <span className="text-muted-foreground">{label}</span>
                  <span className="text-center">
                    {info.actual.probs[key] >= 0
                      ? probabilityBadge(info.actual.probs[key])
                      : <span className="text-[10px] text-muted-foreground/50 italic">—</span>}
                  </span>
                  <span className="text-center">
                    {info.pool.probs[key] >= 0
                      ? probabilityBadge(info.pool.probs[key])
                      : <span className="text-[10px] text-muted-foreground/50 italic">—</span>}
                  </span>
                </Fragment>
              ))}
            </div>

            <div className="text-[10px] text-muted-foreground/70 mt-1 leading-snug">
              <strong>Din avgang</strong> = dagene begge dine faktiske avganger gikk
              {info.actual.source === "aimed" && " (matchet på rutetid, linje, stopp og retning)"}
              {info.actual.source === "sj" && " (matchet på avgangs-ID)"}.
              {" "}<strong>Sammenlignbare</strong> = nærmeste avgang innen ±60 min samme dag; den
              treffer som regel din egen avgang, og gir mest ekstra data på dager din avgang ikke
              gikk. Vi bruker{" "}
              <strong>{info.source === "pool" ? "sammenlignbare" : "din avgang"}</strong> i badges
              og totalen.
            </div>

            {info.actual.days > 0 && info.actual.days < SPECIFIC_MIN_DAYS && (
              <div className="text-[10px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3 inline mr-1" />
                Bare {info.actual.days} {info.actual.days === 1 ? "dag" : "dager"} for din egen
                avgang — det tallet er usikkert. Flere dager gir vesentlig bedre treffsikkerhet.
              </div>
            )}
            {info.actual.days === 0 && (
              <div className="text-[10px] rounded border border-amber-400/50 bg-amber-50 dark:bg-amber-950/20 px-2 py-1.5 text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-3 w-3 inline mr-1" />
                <strong>Ingen historikk for dine egne avganger.</strong> Tallene bygger kun på
                sammenlignbare avganger — bare forsinkelsen deres er overført (planlagt gap +
                forskjellen i forsinkelse den dagen), så klokkeslett vises ikke.
              </div>
            )}
            <a href="/metode#overgang" className="text-[10px] text-primary hover:underline">
              Metode →
            </a>
          </div>
        ) : isPending ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Beregner overgangsdata …
          </p>
        ) : (
          <p className="text-xs text-muted-foreground italic">
            Mangler forsinkelsesdata for å vurdere denne overgangen.
          </p>
        )}

        {rows.length > 0 && (
          <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setShowData((v) => !v)}
            >
              <Database className="h-3 w-3 mr-1" />
              {showData ? "Skjul data" : "Vis data"}
            </Button>
            {showData && (
              <>
                <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground text-left bg-muted/40">
                        <th className="py-1 px-2 font-medium">Dato</th>
                        <th className="py-1 px-2 font-medium text-right whitespace-nowrap">
                          Ankomst
                          <span className="block font-normal text-[10px] text-muted-foreground/70">
                            {info.fromLine ? `linje ${info.fromLine}` : "inn"}
                          </span>
                        </th>
                        <th className="py-1 px-2 font-medium text-right whitespace-nowrap">
                          Avgang
                          <span className="block font-normal text-[10px] text-muted-foreground/70">
                            {info.toLine ? `linje ${info.toLine}` : "ut"}
                          </span>
                        </th>
                        <th className="py-1 px-2 font-medium text-right whitespace-nowrap">
                          Margin
                          <span className="block font-normal text-[10px] text-muted-foreground/70">
                            utover gange
                          </span>
                        </th>
                        <th className="py-1 px-2 font-medium text-right whitespace-nowrap">
                          Innenfor
                          <span className="block font-normal text-[10px] text-muted-foreground/70">
                            din margin?
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {rows.map((o) => {
                        // Margin = gap utover ren gangtid — samme størrelse som
                        // "Overgangsmargin"-filteret lenger oppe, så tallene er
                        // direkte sammenlignbare. made = margin >= din valgte margin.
                        const margin = o.gap - info.walkTime;
                        const made = margin >= transferMarginMin;
                        return (
                          <tr key={o.date} className="border-t border-border/50">
                            <td className="py-1 px-2 whitespace-nowrap font-sans">
                              {formatWeekdayDateNO(o.date)}
                            </td>
                            <td className="py-1 px-2 text-right tabular-nums">
                              {o.arrActualMin != null ? minutesToHM(o.arrActualMin) : "—"}
                            </td>
                            <td className="py-1 px-2 text-right tabular-nums">
                              {o.depActualMin != null ? minutesToHM(o.depActualMin) : "—"}
                            </td>
                            <td className="py-1 px-2 text-right tabular-nums">
                              {margin >= 0 ? "+" : ""}{margin.toFixed(1)}m
                            </td>
                            <td className={cn(
                              "py-1 px-2 text-right",
                              made ? "text-green-600" : "text-red-500",
                            )}>
                              {made ? "✓" : "✗"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  De {rows.length} siste av {info.daysObserved}{" "}
                  {info.daysObserved === 1 ? "dag" : "dager"} med observasjoner.
                  <strong> Ankomst</strong> = når linje {info.fromLine ?? "inn"} kom fram,{" "}
                  <strong>avgang</strong> = når linje {info.toLine ?? "ut"} gikk.{" "}
                  <strong>Margin</strong> = hvor mye tid du hadde utover selve gangtiden
                  ({info.walkTime.toFixed(1)} min) — «Innenfor din margin?» sjekker om det var
                  minst {transferMarginMin} min, samme grense som «Overgangsmargin»-filteret.
                  {isActualDepartureSource(info.source) ? (
                    <> Tidene er faktisk målte for dine to avganger.</>
                  ) : (
                    <> Klokkeslett vises ikke for denne kilden: tallene kommer fra
                    sammenlignbare naboavganger (planlagt gap ± forsinkelsesforskjell),
                    ikke fra dine egne avganger.</>
                  )}
                </p>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Detaljer for en plan i treet: forsinkelse-langs-ruten-graf +
 *  legg-for-legg med avgangs-/ankomsttider og DuckDB-estimerte tider
 *  (~P50 i oransje, P80 i rødt) der vi har data. */
function PlanNodeDetails({
  pattern,
  duckReady,
  duckQuery,
}: {
  pattern: TripPattern;
  duckReady: boolean;
  duckQuery: DuckQueryFn;
}) {
  // Alle stopp langs rutene (inkl. mellomstopp) — grafen trenger hele profilen.
  const pairs = useMemo(() => {
    const out: Array<{ stopRef: string; lineRef: string }> = [];
    const seen = new Set<string>();
    for (const leg of pattern.legs) {
      if (leg.mode === "foot" || !leg.line?.id || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
      for (const q of [
        leg.fromPlace.quay?.id,
        ...leg.intermediateQuays.map((iq) => iq.id),
        leg.toPlace.quay?.id,
      ]) {
        if (!q) continue;
        const k = `${q}|${leg.line.id}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ stopRef: q, lineRef: leg.line.id });
        }
      }
    }
    return out;
  }, [pattern]);

  const { data: stats } = useTripDelayDistribution(pairs, duckReady, duckQuery);

  return (
    <div className="ml-2 mt-1 mb-1 border-l border-border pl-2 space-y-1">
      <PlanDelayChart pattern={pattern} stats={stats} />
      {pattern.legs.map((leg, i) => {
        if (leg.mode === "foot") {
          const min = Math.round((leg.duration ?? 0) / 60);
          if (min <= 0) return null;
          return (
            <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Footprints className="h-2.5 w-2.5" />
              Gå {min} min til {leg.toPlace.name}
            </div>
          );
        }
        const depStat = leg.line?.id ? stats?.get(`${leg.fromPlace.quay?.id}|${leg.line.id}`) : null;
        const arrStat = leg.line?.id ? stats?.get(`${leg.toPlace.quay?.id}|${leg.line.id}`) : null;
        const estDep = depStat?.p50_dep != null
          ? formatTime(addMinutesToIso(leg.expectedStartTime, depStat.p50_dep))
          : null;
        const estArr = arrStat?.p50_arr != null
          ? formatTime(addMinutesToIso(leg.expectedEndTime, arrStat.p50_arr))
          : null;
        const p80Arr = arrStat?.p80_arr != null
          ? formatTime(addMinutesToIso(leg.expectedEndTime, arrStat.p80_arr))
          : null;
        const hasData = MODES_WITH_DELAY_DATA.has(leg.mode) && !!leg.line?.id;
        return (
          <div key={i} className="text-[10px] space-y-0.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="secondary" className="text-[9px] gap-0.5">
                <ModeIcon mode={leg.mode} className="h-2.5 w-2.5" />
                {leg.line?.publicCode ?? modeLabel(leg.mode)}
              </Badge>
              <span className="font-mono tabular-nums">{formatTime(leg.expectedStartTime)}</span>
              {estDep && <span className="font-mono text-amber-500">~{estDep}</span>}
              <span className="text-muted-foreground truncate max-w-32">{leg.fromPlace.name}</span>
              <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />
              <span className="font-mono tabular-nums">{formatTime(leg.expectedEndTime)}</span>
              {estArr && <span className="font-mono text-amber-500">~{estArr}</span>}
              {p80Arr && <span className="font-mono text-red-500/70">P80 {p80Arr}</span>}
              <span className="text-muted-foreground truncate max-w-32">{leg.toPlace.name}</span>
            </div>
            {!hasData && (
              <div className="text-muted-foreground/60 italic ml-1">mangler forsinkelsesdata</div>
            )}
            {hasData && !estDep && !estArr && (
              <div className="text-muted-foreground/60 italic ml-1">
                ingen observasjoner for denne linjen ved disse stoppene ennå
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[9px] text-muted-foreground/60 italic">
        ~tid = rutetid + median historisk forsinkelse (P50). P80 = tiden 4 av 5
        avganger er innenfor.
      </p>
    </div>
  );
}

function TransferFallbacks({
  pattern,
  legAIdx,
  missProb,
  duckStats,
  destination,
  selectedModes,
  walkSpeedKmh,
  transferMarginMin,
  duckReady,
  duckQuery,
}: {
  pattern: TripPattern;
  legAIdx: number;
  missProb: number; // P(miste overgangen), 0–1
  duckStats?: Map<string, DuckDelayRow>;
  destination: Record<string, unknown>;
  selectedModes: string[];
  walkSpeedKmh: number;
  transferMarginMin: number;
  duckReady: boolean;
  duckQuery: DuckQueryFn;
}) {
  const legA = pattern.legs[legAIdx];

  // Neste transit-legg (= det du kan miste) + gangtid dit
  const { legB, walkMin } = useMemo(() => {
    let walkSec = 0;
    for (let i = legAIdx + 1; i < pattern.legs.length; i++) {
      const l = pattern.legs[i];
      if (l.mode === "foot") {
        walkSec += l.duration ?? 0;
      } else {
        return { legB: l, walkMin: walkSec / 60 };
      }
    }
    return { legB: null as TripLeg | null, walkMin: walkSec / 60 };
  }, [pattern, legAIdx]);

  // Realistisk tidspunkt du står klar på overgangsstoppet hvis du mister bussen:
  // planlagt ankomst + P80-ankomstforsinkelse (fallback 5 min) + gangtid.
  const p80ArrDelay = useMemo(() => {
    const quay = legA.toPlace.quay?.id;
    const line = legA.line?.id;
    if (!quay || !line) return null;
    return duckStats?.get(`${quay}|${line}`)?.p80_arr ?? null;
  }, [legA, duckStats]);

  const delayAssumptionMin = Math.max(p80ArrDelay ?? 5, 0);
  const missArrivalIso = useMemo(
    () => addMinutesToIso(legA.expectedEndTime, delayAssumptionMin + walkMin),
    [legA.expectedEndTime, delayAssumptionMin, walkMin],
  );

  const { data: steps, isLoading, isError } = useFallbackChain({
    enabled: !!legB,
    transferQuayId: legB?.fromPlace.quay?.id ?? null,
    destination,
    missProb,
    missArrivalIso,
    missedDepartureIso: legB?.expectedStartTime ?? null,
    missedSjId: legB?.serviceJourney?.id ?? null,
    selectedModes,
    walkSpeedKmh,
    transferMarginMin,
    duckReady,
    duckQuery,
  });

  // Hvilken plan-node som viser graf/detaljer: "A", "0", "0-alt-1", ...
  const [openKey, setOpenKey] = useState<string | null>(null);

  // Forventet ankomst: p(A) × ankomst_A + Σ p(bruk plan k) × ankomst_k.
  // Siste plan i kjeden får all gjenværende sannsynlighet (kjeden er kuttet <5 %).
  // Rene alternativer (altOnly, f.eks. buss når gange er raskest) telles ikke med.
  const expectation = useMemo(() => {
    const effSteps = (steps ?? []).filter((s) => !s.altOnly);
    if (effSteps.length === 0) return null;
    const terms: Array<{ label: string; prob: number; arrIso: string }> = [
      { label: "plan A", prob: 1 - missProb, arrIso: pattern.expectedEndTime },
    ];
    for (let i = 0; i < effSteps.length; i++) {
      const isLast = i === effSteps.length - 1;
      const useProb = isLast ? effSteps[i].needProb : effSteps[i].needProb * effSteps[i].makeProb;
      terms.push({
        label: `plan ${PLAN_LETTERS[i]}`,
        prob: useProb,
        arrIso: effSteps[i].pattern.expectedEndTime,
      });
    }
    const totalProb = terms.reduce((a, t) => a + t.prob, 0);
    if (totalProb <= 0) return null;
    const expMs = terms.reduce((a, t) => a + (t.prob / totalProb) * new Date(t.arrIso).getTime(), 0);
    return { terms, expectedIso: new Date(expMs).toISOString() };
  }, [steps, missProb, pattern.expectedEndTime]);

  if (!legB || missProb < FALLBACK_PROB_FLOOR) return null;

  const origArrMs = new Date(pattern.expectedEndTime).getTime();

  // Tre-struktur: kjeden av planer (B → C → D ...), med rene alternativer
  // (altOnly, f.eks. buss når gange er raskest) hektet på planen de følger.
  const chain: Array<{ step: FallbackStep; alts: FallbackStep[] }> = [];
  for (const s of steps ?? []) {
    if (s.altOnly && chain.length > 0) chain[chain.length - 1].alts.push(s);
    else if (!s.altOnly) chain.push({ step: s, alts: [] });
  }

  const detailsToggle = (k: string) => (
    <button
      className="text-primary hover:underline flex items-center gap-0.5 flex-shrink-0"
      onClick={() => setOpenKey(openKey === k ? null : k)}
    >
      <BarChart3 className="h-2.5 w-2.5" />
      {openKey === k ? (
        <>Skjul graf <ChevronUp className="h-2.5 w-2.5" /></>
      ) : (
        <>Vis graf <ChevronDown className="h-2.5 w-2.5" /></>
      )}
    </button>
  );

  const renderPlanRow = (step: FallbackStep, planIdx: number, k: string) => {
    const deltaMin = Math.round(
      (new Date(step.pattern.expectedEndTime).getTime() - origArrMs) / 60000,
    );
    const transitLegs = step.pattern.legs.filter((l) => l.mode !== "foot");
    const walkMinutes = Math.round(
      step.pattern.legs.reduce((a, l) => a + (l.mode === "foot" ? l.duration ?? 0 : 0), 0) / 60,
    );
    return (
      <div key={k} className="text-xs space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[9px] border-amber-400/60 text-amber-700 dark:text-amber-400">
            {step.altOnly ? "Alternativ buss" : `Plan ${PLAN_LETTERS[planIdx]}${step.isWalk ? " — gå" : ""}`}
          </Badge>
          <span className="font-mono">{formatTime(step.pattern.expectedStartTime)}</span>
          {step.isWalk ? (
            <Badge variant="secondary" className="text-[9px] gap-0.5">
              <Footprints className="h-2.5 w-2.5" />
              {walkMinutes} min gange
            </Badge>
          ) : (
            transitLegs.map((l, j) => (
              <Badge key={j} variant="secondary" className="text-[9px] gap-0.5">
                <ModeIcon mode={l.mode} className="h-2.5 w-2.5" />
                {l.line?.publicCode ?? modeLabel(l.mode)}
              </Badge>
            ))
          )}
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono">{formatTime(step.pattern.expectedEndTime)}</span>
          <span className={cn("font-mono text-[10px]", deltaMin > 0 ? "text-red-500" : "text-green-600")}>
            ({deltaMin >= 0 ? "+" : ""}{deltaMin} min)
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground ml-1 flex items-center gap-2 flex-wrap">
          <span>
            {step.altOnly ? (
              <>Hvis du heller vil vente på buss enn å gå — ikke med i tidsestimatet</>
            ) : (
              <>Trengs med {Math.round(step.needProb * 100)} % sannsynlighet</>
            )}
            {step.isWalk && <> · gange påvirkes ikke av forsinkelser</>}
            {step.makeProb < 1 && (
              <> · egen overgang går {Math.round(step.makeProb * 100)} % av dagene
                {step.daysObservedMin != null && ` (${step.daysObservedMin} dager data)`}
              </>
            )}
          </span>
          {!step.isWalk && detailsToggle(k)}
        </div>
        {openKey === k && (
          <PlanNodeDetails
            pattern={step.pattern}
            duckReady={duckReady}
            duckQuery={duckQuery}
          />
        )}
      </div>
    );
  };

  // Rekursiv gren: "mister du også denne → neste plan"
  const renderBranch = (i: number): React.ReactNode => {
    if (i >= chain.length) return null;
    const { step, alts } = chain[i];
    return (
      <div className="ml-1.5 border-l-2 border-amber-300/50 pl-3 pt-1.5 space-y-1">
        <div className="text-[10px] font-medium text-amber-700 dark:text-amber-400">
          ↳ {i === 0
            ? `hvis du mister overgangen (${Math.round(missProb * 100)} % sjanse)`
            : `hvis du også mister plan ${PLAN_LETTERS[i - 1]} sin overgang (${Math.round(step.needProb * 100)} %)`}
        </div>
        {renderPlanRow(step, i, `${i}`)}
        {alts.map((a, j) => renderPlanRow(a, i, `${i}-alt-${j}`))}
        {renderBranch(i + 1)}
      </div>
    );
  };

  return (
    <div className="ml-5 mt-2 border-l-2 border-amber-300/50 pl-3 space-y-1.5">
      <p className="text-[10px] font-medium text-amber-700 dark:text-amber-400 uppercase tracking-wide">
        Plan A → {PLAN_LETTERS.slice(0, Math.max(chain.length, 1)).join(" → ")}
      </p>
      {/* Rot-node: planen du faktisk har valgt */}
      <div className="text-xs space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[9px] border-primary/40 text-primary">Plan A</Badge>
          <span className="font-mono">{formatTime(pattern.expectedStartTime)}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono">{formatTime(pattern.expectedEndTime)}</span>
          <span className="text-[10px] text-muted-foreground">
            rekker overgangen {Math.round((1 - missProb) * 100)} % av dagene
          </span>
          {detailsToggle("A")}
        </div>
        {openKey === "A" && (
          <PlanNodeDetails pattern={pattern} duckReady={duckReady} duckQuery={duckQuery} />
        )}
      </div>
      {isLoading && <p className="text-xs text-muted-foreground">Beregner plan B...</p>}
      {isError && <p className="text-xs text-muted-foreground italic">Kunne ikke hente alternativ reise.</p>}
      {renderBranch(0)}
      {expectation && (
        <div className="text-[10px] text-muted-foreground pt-1 border-t border-border/50">
          <span className="font-medium">Forventet ankomst: </span>
          {expectation.terms
            .filter((t) => t.prob >= 0.005)
            .map((t, i) => (
              <span key={i}>
                {i > 0 && " + "}
                {Math.round(t.prob * 100)} % × {formatTime(t.arrIso)}
              </span>
            ))}
          {" ≈ "}
          <span className="font-mono font-medium text-foreground">
            {formatTime(expectation.expectedIso)}
          </span>
        </div>
      )}
      <p className="text-[9px] text-muted-foreground/60 italic">
        Plan {PLAN_LETTERS.slice(0, Math.max((steps ?? []).filter((s) => !s.altOnly).length, 1)).join("/")} er søkt fra{" "}
        {legB.fromPlace.quay?.name ?? legB.fromPlace.name} med avreise{" "}
        {formatTime(missArrivalIso)} (planlagt ankomst + P80-forsinkelse
        {p80ArrDelay == null && " [antatt 5 min — mangler data]"} + gangtid), tidligst
        1 min etter den mistede avgangen. Ren gange vurderes alltid og velges som plan
        hvis den gir tidligere ankomst enn neste buss. Kjeden stopper når
        sannsynligheten for å trenge neste plan er under 5 %.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trip result card
// ---------------------------------------------------------------------------

function TripCard({
  pattern,
  index,
  stats,
  duckStats,
  transferMarginMin,
  walkSpeedKmh,
  sprintSpeedKmh,
  duckReady,
  duckQuery,
  expanded,
  onToggleExpanded,
  onPatternChange,
  destination,
  selectedModes,
  gapMap,
  showPct,
}: {
  pattern: TripPattern;
  index: number;
  stats: Map<string, TripStopStat>;
  duckStats?: Map<string, DuckDelayRow>;
  transferMarginMin: number;
  walkSpeedKmh: number;
  sprintSpeedKmh: number;
  duckReady: boolean;
  duckQuery: DuckQueryFn;
  expanded: boolean;
  onToggleExpanded: () => void;
  onPatternChange: (newPattern: TripPattern) => void;
  destination: Record<string, unknown> | null;
  selectedModes: string[];
  /** Overgangs-gap beregnet på sidenivå (prefetches for alle forslag). */
  gapMap?: Map<string, TransferGapResult>;
  /** Hvilke persentil-kolonner som vises per stopp. */
  showPct: { p50: boolean; p80: boolean; p95: boolean };
}) {
  // Hvilket legg som viser "andre avganger"-panelet
  const [altOpenLeg, setAltOpenLeg] = useState<number | null>(null);
  // Legg der brukeren har utvidet den kollapsede stopplisten
  const [stopsExpandedLegs, setStopsExpandedLegs] = useState<Set<number>>(new Set());
  // Overgangsanalyse-dialog: hvilken overgang (indeks) som er åpen
  const [analysisOpenIdx, setAnalysisOpenIdx] = useState<number | null>(null);
  // Legg der brukeren har åpnet "hele avgangen"-visningen (klikk på linjenr)
  const [journeyOpenLeg, setJourneyOpenLeg] = useState<number | null>(null);
  // Rutekart (lat — Leaflet/kartflisene lastes først når brukeren klikker)
  const [showMap, setShowMap] = useState(false);
  // Gå-legg der brukeren har åpnet «Vis veibeskrivelse» (mini-kart for gangen)
  const [walkMapLeg, setWalkMapLeg] = useState<number | null>(null);

  // ---------- Build transfer specs (one per transit→transit handover) ----------
  // Samme spec-nøkler ("t0", "t1", ...) som sidenivå-prefetchen bruker.
  const transferSpecs = useMemo<TransferSpec[]>(
    () => buildTransferSpecsForPattern(pattern),
    [pattern],
  );

  // Estimert avgangs-/ankomsttid spørres fortsatt bare for UTVIDEDE kort —
  // overgangs-gapene kommer ferdig beregnet fra sidenivået (gapMap-prop).
  const duckActive = duckReady && expanded;

  // ---------- Per-SJ estimated departure/arrival times ----------
  const legTimingSpecs = useMemo<LegTimingSpec[]>(() => {
    const dayType = computeDayType(pattern.expectedStartTime);
    const aimedHour = new Date(pattern.expectedStartTime).getHours();
    const specs: LegTimingSpec[] = [];
    let firstTransit = true;
    for (let i = 0; i < pattern.legs.length; i++) {
      const leg = pattern.legs[i];
      if (leg.mode === "foot" || !leg.line?.id || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
      if (firstTransit) {
        const fromQuay = leg.fromPlace.quay?.id;
        if (fromQuay) {
          specs.push({ key: "dep", serviceJourneyId: leg.serviceJourney?.id ?? "", quayRef: fromQuay, lineRef: leg.line.id, kind: "dep", aimedHour, dayType });
        }
        firstTransit = false;
      }
      const toQuay = leg.toPlace.quay?.id;
      if (toQuay) {
        specs.push({ key: `arr_${i}`, serviceJourneyId: leg.serviceJourney?.id ?? "", quayRef: toQuay, lineRef: leg.line.id, kind: "arr", aimedHour, dayType });
      }
    }
    return specs;
  }, [pattern]);

  const { data: legTimes } = useEstimatedLegTimes(legTimingSpecs, duckActive, duckQuery);

  // ---------- Compute transfer probabilities + overall probability ----------
  // Empirical per-day pairing: for each historical day where both the arriving
  // and the departing service journey ran, we know the actual gap (in minutes)
  // between them. Probability = #days where gap ≥ walk + margin / total #days.
  // This handles "both buses stuck in same queue" naturally — both observations
  // come from the same day. Falls back to hour-of-day pooling per (line, stop)
  // when the specific SJ pair has too few historical observations.
  const transferAnalysis = useMemo(() => {
    const transfers: TransferInfo[] = [];

    const transitIdxs: number[] = [];
    const transferIdxByLeg: Map<number, number> = new Map();
    for (let i = 0; i < pattern.legs.length; i++) {
      if (pattern.legs[i].mode !== "foot") transitIdxs.push(i);
    }
    for (let t = 0; t < transitIdxs.length - 1; t++) {
      transferIdxByLeg.set(transitIdxs[t], t);
    }

    for (let t = 0; t < transitIdxs.length - 1; t++) {
      const aIdx = transitIdxs[t];
      const bIdx = transitIdxs[t + 1];
      const legA = pattern.legs[aIdx];
      const legB = pattern.legs[bIdx];

      let walkSec = 0;
      for (let k = aIdx + 1; k < bIdx; k++) {
        if (pattern.legs[k].mode === "foot") walkSec += pattern.legs[k].duration ?? 0;
      }
      const walkTime = walkSec / 60;
      const sprintRatio = sprintSpeedKmh > 0 ? walkSpeedKmh / sprintSpeedKmh : 1;
      const sprintWalkTime = walkTime * sprintRatio;

      const totalGap = (new Date(legB.expectedStartTime).getTime() - new Date(legA.expectedEndTime).getTime()) / 60000;

      // Umulig overgang (gap mindre enn ren gangtid) — flagges eksplisitt i
      // stedet for å skjules, slik at manuelt byttede avganger vises som brutte.
      if (totalGap < walkTime) {
        transfers.push({
          buffer: totalGap,
          walkTime,
          sprintWalkTime,
          probs: { default: -1, user: -1, sprint: -1 },
          daysObserved: 0,
          source: "none",
          fromLine: legA.line?.publicCode ?? null,
          toLine: legB.line?.publicCode ?? null,
          assumingOnTime: false,
          broken: true,
          observations: [],
          actual: { days: 0, source: "none", probs: { default: -1, user: -1, sprint: -1 } },
          pool: { days: 0, probs: { default: -1, user: -1, sprint: -1 } },
        });
        continue;
      }

      const hasDelayData = MODES_WITH_DELAY_DATA.has(legA.mode) && !!legA.line?.id;
      const assumingOnTime = !hasDelayData;

      // Find the empirical gap distribution for this transfer.
      const spec = transferSpecs[t];
      const gapResult = spec ? gapMap?.get(spec.key) : undefined;
      const gaps = gapResult?.gaps ?? [];
      const source = gapResult?.source ?? "none";

      // Samme tre terskler, men beregnet for et vilkårlig sett med gap —
      // brukes både for den valgte kilden og for hvert spor hver for seg.
      const probsFrom = (g: number[]): TransferProbs => {
        const f = (buf: number) =>
          !hasDelayData || g.length === 0 ? -1 : probFromGaps(g, buf);
        return {
          default: f(walkTime + 2),
          user: f(walkTime + transferMarginMin),
          // Spurt: gangtiden skalert til spurt-tempo + 10 sek sikkerhetsmargin
          sprint: f(sprintWalkTime + SPRINT_MARGIN_MIN),
        };
      };

      transfers.push({
        buffer: totalGap,
        walkTime,
        sprintWalkTime,
        probs: probsFrom(gaps),
        daysObserved: gaps.length,
        source,
        fromLine: legA.line?.publicCode ?? null,
        toLine: legB.line?.publicCode ?? null,
        assumingOnTime,
        broken: false,
        observations: gapResult?.observations ?? [],
        actual: {
          days: gapResult?.actual.days ?? 0,
          source: gapResult?.actual.source ?? "none",
          probs: probsFrom(gapResult?.actual.gaps ?? []),
        },
        pool: {
          days: gapResult?.pool.days ?? 0,
          probs: probsFrom(gapResult?.pool.gaps ?? []),
        },
      });
    }

    // Brutte overganger teller som 0 % i totalen
    const knownProbs = transfers
      .map((t) => (t.broken ? 0 : t.probs.default))
      .filter((p) => p >= 0);
    const overallProb = knownProbs.length > 0
      ? knownProbs.reduce((a, b) => a * b, 1)
      : -1;
    const hasTransfers = transfers.length > 0;

    return { transfers, overallProb, hasTransfers, transferIdxByLeg };
  }, [pattern, transferSpecs, gapMap, transferMarginMin, walkSpeedKmh, sprintSpeedKmh]);

  // ---------- Compute estimated departure/arrival and P80 from per-SJ DuckDB data ----------
  const estimatedTimes = useMemo(() => {
    const depResult = legTimes?.get("dep");

    // Find last transit leg index to locate its arr result
    let lastArrResult: LegTimingResult | undefined;
    for (let i = pattern.legs.length - 1; i >= 0; i--) {
      const leg = pattern.legs[i];
      if (leg.mode === "foot" || !leg.line?.id || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
      lastArrResult = legTimes?.get(`arr_${i}`);
      break;
    }

    const firstBusDelayDep = depResult?.p50 ?? (() => {
      for (const leg of pattern.legs) {
        if (leg.mode === "foot" || !leg.line?.id || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
        const fromQuay = leg.fromPlace.quay?.id;
        if (!fromQuay) continue;
        const stat = stats.get(`${fromQuay}|${leg.line.id}`);
        return stat?.avgDelayDepartureMin ?? stat?.avgDelayMin ?? null;
      }
      return null;
    })();

    const lastBusDelayArr = lastArrResult?.p50 ?? (() => {
      for (let i = pattern.legs.length - 1; i >= 0; i--) {
        const leg = pattern.legs[i];
        if (leg.mode === "foot" || !leg.line?.id || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
        const toQuay = leg.toPlace.quay?.id;
        if (!toQuay) continue;
        const stat = stats.get(`${toQuay}|${leg.line.id}`);
        return stat?.avgDelayArrivalMin ?? stat?.avgDelayMin ?? null;
      }
      return null;
    })();

    const estDeparture = firstBusDelayDep != null
      ? formatTime(addMinutesToIso(pattern.expectedStartTime, firstBusDelayDep))
      : null;
    const estArrival = lastBusDelayArr != null
      ? formatTime(addMinutesToIso(pattern.expectedEndTime, lastBusDelayArr))
      : null;

    // P80: worst across all transit legs — from per-SJ data, fallback to server avg
    let worstRealP80: number | null = null;
    let worstAvgDelay: number | null = null;
    for (let i = 0; i < pattern.legs.length; i++) {
      const leg = pattern.legs[i];
      if (leg.mode === "foot" || !leg.line?.id || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
      const arrRes = legTimes?.get(`arr_${i}`);
      if (arrRes?.p80 != null && (worstRealP80 == null || arrRes.p80 > worstRealP80)) {
        worstRealP80 = arrRes.p80;
      }
      const toQuay = leg.toPlace.quay?.id;
      if (toQuay) {
        const d = stats.get(`${toQuay}|${leg.line.id}`)?.avgDelayMin ?? null;
        if (d != null && (worstAvgDelay == null || d > worstAvgDelay)) worstAvgDelay = d;
      }
    }
    const p80 = estimateP80(worstAvgDelay, worstRealP80);

    return { estDeparture, estArrival, p80, depResult, arrResult: lastArrResult };
  }, [pattern, stats, legTimes]);

  return (
    <Card className={cn("transition-all", index === 0 && "border-primary/50")}>
      <div
        className="cursor-pointer p-4 pb-3"
        onClick={onToggleExpanded}
      >
        {/* --- Collapsed summary row --- */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-start">
              <span className="text-lg font-bold font-mono">
                {formatTime(pattern.expectedStartTime)}
              </span>
              {estimatedTimes.estDeparture && (
                <span className="flex items-center gap-0.5">
                  <span className="text-xs font-mono text-amber-500">~{estimatedTimes.estDeparture}</span>
                  {estimatedTimes.depResult && (
                    <span title={legTimingTooltip(estimatedTimes.depResult)} className="cursor-help">
                      <Info className="w-3 h-3 text-muted-foreground/60" />
                    </span>
                  )}
                </span>
              )}
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col items-start">
              <span className="text-lg font-bold font-mono">
                {formatTime(pattern.expectedEndTime)}
              </span>
              {estimatedTimes.estArrival && (
                <span className="flex items-center gap-0.5">
                  <span className="text-xs font-mono text-amber-500">~{estimatedTimes.estArrival}</span>
                  {estimatedTimes.arrResult && (
                    <span title={legTimingTooltip(estimatedTimes.arrResult)} className="cursor-help">
                      <Info className="w-3 h-3 text-muted-foreground/60" />
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <Badge variant="secondary" className="text-xs">
              <Clock className="h-3 w-3 mr-1" />
              {formatDuration(pattern.duration)}
            </Badge>
            {/* Overgangssannsynlighet, "Gange" (ren gåtur) eller "Direkte" */}
            {isWalkOnlyPattern(pattern) ? (
              <Badge variant="outline" className="text-green-600 border-green-300 text-[10px] gap-1">
                <Footprints className="h-2.5 w-2.5" />
                Gange
              </Badge>
            ) : transferAnalysis.hasTransfers ? (
              transferAnalysis.overallProb >= 0 ? (
                probabilityBadge(transferAnalysis.overallProb)
              ) : (
                <Badge variant="outline" className="text-muted-foreground/50 border-dashed text-[9px]">overgang</Badge>
              )
            ) : (
              <Badge variant="outline" className="text-green-600 border-green-300 text-[10px]">Direkte</Badge>
            )}
            {/* P80 estimate */}
            {estimatedTimes.p80 && (
              <Badge variant="outline" className="text-[9px] text-muted-foreground border-dashed">
                P80 est. {estimatedTimes.p80}
              </Badge>
            )}
            {expanded
              ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
              : <ChevronDown className="h-4 w-4 text-muted-foreground" />
            }
          </div>
        </div>
        {/* Compact line summary with mode icons */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {pattern.legs.map((leg, i) => (
            <Badge key={i} variant="outline" className="text-xs gap-1">
              <ModeIcon mode={leg.mode} className="h-3 w-3" />
              {leg.line?.publicCode
                ? `${leg.line.publicCode}`
                : modeLabel(leg.mode)
              }
            </Badge>
          ))}
        </div>
      </div>

      {expanded && (
        <CardContent className="pt-0 space-y-3">
          {pattern.legs.map((leg, legIdx) => {
            const lineRef = leg.line?.id ?? "";
            const hasDelayData = MODES_WITH_DELAY_DATA.has(leg.mode) && !!lineRef;

            // Alle quay-stopp i legget, med rutetid fra serviceJourney.passingTimes
            // (delt hjelper — samme logikk brukes av plan-grafene)
            const allStops: StopEntry[] = legStops(leg);

            // Attach transferInfo on the inbound transit leg (= legA of a transit→transit pair).
            const transferIdx = transferAnalysis.transferIdxByLeg.get(legIdx);
            const transferInfo = transferIdx != null
              ? transferAnalysis.transfers[transferIdx] ?? null
              : null;

            // Walking leg — compact display + egen «Vis veibeskrivelse» (mini-
            // kart zoomet på gangstrekket). Knappen vises bare når vi har
            // geometri for gangen.
            if (leg.mode === "foot") {
              const distM = Math.round(leg.distance || 0);
              const hasWalkGeom = !!leg.pointsOnLink && distM > 0;
              const walkOpen = walkMapLeg === legIdx;
              return (
                <div key={legIdx}>
                  <div className="flex items-center gap-2 py-1.5 px-3 text-xs text-muted-foreground">
                    <Footprints className="h-3 w-3 flex-shrink-0" />
                    <span>
                      Gå {distM > 0 ? `${distM}m` : ""} til {leg.toPlace.name}
                      {leg.duration > 0 && ` (${Math.round(leg.duration / 60)} min)`}
                    </span>
                    {hasWalkGeom && (
                      <button
                        className="ml-auto flex items-center gap-0.5 text-[10px] text-primary hover:underline flex-shrink-0"
                        onClick={() => setWalkMapLeg(walkOpen ? null : legIdx)}
                      >
                        <MapIcon className="h-2.5 w-2.5" />
                        {walkOpen ? "Skjul veibeskrivelse" : "Vis veibeskrivelse"}
                      </button>
                    )}
                  </div>
                  {hasWalkGeom && walkOpen && (
                    <div className="px-3">
                      <TripRouteMap pattern={{ ...pattern, legs: [leg] }} />
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div key={legIdx}>
                <div className="border rounded-lg p-3 bg-muted/20">
                  {/* Leg header */}
                  <div className="flex items-center justify-between mb-2">
                    {(() => {
                      const canOpenJourney = !!leg.serviceJourney?.id;
                      const journeyOpen = journeyOpenLeg === legIdx;
                      const header = (
                        <>
                          <ModeIcon mode={leg.mode} className="h-4 w-4 text-primary" />
                          {leg.line?.publicCode ? (
                            <Badge className="text-xs font-mono">{leg.line.publicCode}</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">{modeLabel(leg.mode)}</Badge>
                          )}
                          {leg.line?.name && (
                            <span className="text-xs text-muted-foreground truncate max-w-48">{leg.line.name}</span>
                          )}
                          {canOpenJourney && (
                            journeyOpen
                              ? <ChevronUp className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                              : <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                          )}
                          {!hasDelayData && (
                            <span className="text-[9px] text-muted-foreground/60 italic">
                              mangler data{leg.line?.publicCode ? ` for linje ${leg.line.publicCode}` : ""}
                            </span>
                          )}
                        </>
                      );
                      return canOpenJourney ? (
                        <button
                          type="button"
                          className="flex items-center gap-2 hover:opacity-80 transition-opacity text-left"
                          title="Vis hele avgangen (alle stopp) med forsinkelsestall"
                          onClick={() => setJourneyOpenLeg(journeyOpen ? null : legIdx)}
                        >
                          {header}
                        </button>
                      ) : (
                        <div className="flex items-center gap-2">{header}</div>
                      );
                    })()}
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-muted-foreground">
                        {formatTime(leg.expectedStartTime)} - {formatTime(leg.expectedEndTime)}
                      </span>
                      {leg.fromPlace.quay?.id && leg.line?.id && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px] text-muted-foreground"
                          onClick={() => setAltOpenLeg(altOpenLeg === legIdx ? null : legIdx)}
                        >
                          <ArrowDownUp className="h-3 w-3 mr-1" />
                          Bytt avgang
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Hele avgangen (alle stopp) — prefetches i bakgrunnen når
                      kortet er utvidet, vises når linjenr. klikkes. */}
                  {leg.serviceJourney?.id && leg.line?.id && (
                    <ServiceJourneyDetail
                      sjId={leg.serviceJourney.id}
                      dateIso={leg.expectedStartTime}
                      lineRef={leg.line.id}
                      highlightFromQuay={leg.fromPlace.quay?.id ?? null}
                      highlightToQuay={leg.toPlace.quay?.id ?? null}
                      open={journeyOpenLeg === legIdx}
                      active={expanded}
                      showPct={showPct}
                      duckReady={duckReady}
                      duckQuery={duckQuery}
                    />
                  )}

                  {/* Stops along leg — lange legg kollapses til første + siste stopp */}
                  {(() => {
                    const renderStopRow = (stop: StopEntry, stopIdx: number) => {
                      const statKey = `${stop.id}|${lineRef}`;
                      const duckStop = duckStats?.get(statKey);
                      const isFirst = stopIdx === 0;
                      const isLast = stopIdx === allStops.length - 1;

                      // Per-stop timing (only if we have aimed time).
                      // Last stop has no departure — use arrival delay there.
                      const p50Raw = isLast
                        ? (duckStop?.p50_arr ?? null)
                        : (duckStop?.p50_dep ?? null);
                      const p80Raw = isLast
                        ? (duckStop?.p80_arr ?? null)
                        : (duckStop?.p80_dep ?? null);
                      const p95Raw = isLast
                        ? (duckStop?.p95_arr ?? null)
                        : (duckStop?.p95_dep ?? null);
                      const p50Time = showPct.p50 && stop.aimedTime && p50Raw != null
                        ? formatTime(addMinutesToIso(stop.aimedTime, p50Raw))
                        : null;
                      const p80Time = showPct.p80 && stop.aimedTime && p80Raw != null
                        ? formatTime(addMinutesToIso(stop.aimedTime, p80Raw))
                        : null;
                      const p95Time = showPct.p95 && stop.aimedTime && p95Raw != null
                        ? formatTime(addMinutesToIso(stop.aimedTime, p95Raw))
                        : null;

                      return (
                        <div key={stop.id + stopIdx} className="flex items-center gap-1.5 text-xs">
                          <div className={cn(
                            "w-2 h-2 rounded-full flex-shrink-0",
                            isFirst || isLast ? "bg-primary" : "bg-muted-foreground/40"
                          )} />
                          <span className={cn(
                            "flex-1",
                            (isFirst || isLast) ? "font-medium" : "text-muted-foreground"
                          )}>
                            {stop.name}
                          </span>
                          {/* Perrong/plattform — vises på på-/avstigning (og alle stopp med kjent perrong) */}
                          {stop.platform && (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[9px] px-1 py-0 font-mono flex-shrink-0",
                                (isFirst || isLast) ? "border-primary/40 text-primary" : "text-muted-foreground",
                              )}
                              title="Perrong"
                            >
                              Perrong {stop.platform}
                            </Badge>
                          )}
                          {/* Timetable time */}
                          {stop.aimedTime && (
                            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                              {formatTime(stop.aimedTime)}
                            </span>
                          )}
                          {/* P50 estimated (orange) */}
                          {p50Time && (
                            <span className="font-mono text-[10px] text-amber-500 tabular-nums">
                              ~{p50Time}
                            </span>
                          )}
                          {/* P80 (red) */}
                          {p80Time && (
                            <span className="font-mono text-[10px] text-red-500/70 tabular-nums">
                              {p80Time}
                            </span>
                          )}
                          {/* P95 (violet) — vises når P95-avkryssingen er på */}
                          {p95Time && (
                            <span className="font-mono text-[10px] text-violet-500/80 tabular-nums">
                              {p95Time}
                            </span>
                          )}
                        </div>
                      );
                    };

                    const collapsed =
                      allStops.length > STOP_COLLAPSE_THRESHOLD &&
                      !stopsExpandedLegs.has(legIdx);

                    return (
                      <div className="space-y-1 ml-2">
                        {collapsed ? (
                          <>
                            {renderStopRow(allStops[0], 0)}
                            <button
                              className="flex items-center gap-1 text-[11px] text-primary hover:underline py-0.5 ml-3.5"
                              onClick={() =>
                                setStopsExpandedLegs((prev) => new Set(prev).add(legIdx))
                              }
                            >
                              <ChevronDown className="h-3 w-3" />
                              Vis {allStops.length - 2} mellomliggende stopp
                            </button>
                            {renderStopRow(allStops[allStops.length - 1], allStops.length - 1)}
                          </>
                        ) : (
                          <>
                            {allStops.map(renderStopRow)}
                            {allStops.length > STOP_COLLAPSE_THRESHOLD && (
                              <button
                                className="flex items-center gap-1 text-[11px] text-primary hover:underline py-0.5 ml-3.5"
                                onClick={() =>
                                  setStopsExpandedLegs((prev) => {
                                    const s = new Set(prev);
                                    s.delete(legIdx);
                                    return s;
                                  })
                                }
                              >
                                <ChevronUp className="h-3 w-3" />
                                Skjul mellomliggende stopp
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })()}

                  {/* Andre avganger for dette legget */}
                  {altOpenLeg === legIdx && (
                    <LegAlternatives
                      pattern={pattern}
                      legIdx={legIdx}
                      onSelect={(newStartIso, sjId) => {
                        onPatternChange(shiftPatternLeg(pattern, legIdx, newStartIso, sjId));
                        setAltOpenLeg(null);
                      }}
                    />
                  )}
                </div>

                {/* Kompakt overgangsrad — detaljene bor i overgangsanalyse-dialogen */}
                {transferInfo && (
                  <div className="py-2 px-3 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <ArrowDown className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        Overgang: {transferInfo.buffer.toFixed(0)} min
                        {transferInfo.walkTime > 0 && ` (${transferInfo.walkTime.toFixed(1)} min gange)`}
                        {transferInfo.fromLine && transferInfo.toLine && (
                          <> · linje {transferInfo.fromLine} &rarr; {transferInfo.toLine}</>
                        )}
                        <InfoTip learnMoreHref="/metode#overgang">
                          Sannsynligheten for å rekke overgangen beregnes empirisk fra historiske
                          dager der begge avgangene faktisk gikk. Ikke en simulering eller
                          gjennomsnittsberegning.
                        </InfoTip>
                      </span>
                      {transferInfo.broken ? (
                        <Badge variant="destructive" className="text-[10px]">rekker ikke</Badge>
                      ) : transferInfo.probs.default >= 0 ? (
                        probabilityBadge(transferInfo.probs.default)
                      ) : gapMap ? (
                        <Badge variant="outline" className="text-muted-foreground/50 border-dashed text-[9px]">
                          ingen data
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground/50 border-dashed text-[9px]">
                          beregner…
                        </Badge>
                      )}
                      {!transferInfo.broken && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => setAnalysisOpenIdx(transferIdx ?? null)}
                        >
                          <BarChart3 className="h-3 w-3 mr-1" />
                          Overgangsanalyse
                        </Button>
                      )}
                    </div>
                    {transferInfo.broken && (
                      <div className="ml-5 text-xs text-red-600 dark:text-red-400 flex items-center gap-1.5 font-medium">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Rekker ikke neste buss — gapet ({transferInfo.buffer.toFixed(0)} min) er
                        mindre enn gangtiden ({transferInfo.walkTime.toFixed(1)} min). Bytt til en
                        senere avgang på neste legg, eller en tidligere på dette.
                      </div>
                    )}
                    {/* Datagrunnlaget for DIN avgang vises alltid, ikke bare i dialogen */}
                    {!transferInfo.broken && transferInfo.probs.default >= 0 && (
                      <div className={cn(
                        "ml-5 text-[10px]",
                        transferInfo.actual.days === 0 || transferInfo.actual.days < SPECIFIC_MIN_DAYS
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground/70",
                      )}>
                        {(transferInfo.actual.days === 0 ||
                          transferInfo.actual.days < SPECIFIC_MIN_DAYS) && (
                          <AlertTriangle className="h-3 w-3 inline mr-1" />
                        )}
                        {transferInfo.actual.days > 0
                          ? `${transferInfo.actual.days} ${transferInfo.actual.days === 1 ? "dag" : "dager"} med dine egne avganger`
                          : "ingen historikk for dine egne avganger"}
                        {transferInfo.pool.days > 0 && (
                          <> · {transferInfo.pool.days} sammenlignbare</>
                        )}
                      </div>
                    )}
                    {/* Plan-tre (B/C/D) når overgangen kan ryke (>5 % sjanse) */}
                    {destination &&
                      (transferInfo.broken ||
                        (transferInfo.probs.default >= 0 && transferInfo.probs.default < 0.95)) && (
                        <TransferFallbacks
                          pattern={pattern}
                          legAIdx={legIdx}
                          missProb={transferInfo.broken ? 1 : 1 - transferInfo.probs.default}
                          duckStats={duckStats}
                          destination={destination}
                          selectedModes={selectedModes}
                          walkSpeedKmh={walkSpeedKmh}
                          transferMarginMin={transferMarginMin}
                          duckReady={duckReady}
                          duckQuery={duckQuery}
                        />
                      )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Rutekart — nederst i reiseforslaget. Lat: Leaflet/kartflisene
              lastes først når brukeren klikker «Vis kart». */}
          <div className="pt-1">
            <Button
              variant={showMap ? "secondary" : "outline"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setShowMap((v) => !v)}
            >
              <MapIcon className="h-3 w-3 mr-1" />
              {showMap ? "Skjul kart" : "Vis kart"}
            </Button>
            {showMap && <TripRouteMap pattern={pattern} stats={duckStats} />}
          </div>

          {/* Overgangsanalyse-dialog for valgt overgang */}
          {analysisOpenIdx != null && transferAnalysis.transfers[analysisOpenIdx] && (
            <TransferAnalysisDialog
              info={transferAnalysis.transfers[analysisOpenIdx]}
              transferMarginMin={transferMarginMin}
              sprintSpeedKmh={sprintSpeedKmh}
              isPending={!gapMap}
              onClose={() => setAnalysisOpenIdx(null)}
            />
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// URL-persistering av søket (ref+navn holder — trenger ikke hele geocoder-
// resultatet igjen). "coords:lat,lng" som stopRef (adressesøk) beholder
// lat/lng gjennom prefikset; ekte stopp trenger dem aldri (locationRef()
// prioriterer alltid stopPlaceRef først).
// ---------------------------------------------------------------------------

function encodeStopForUrl(s: StopSearchResult): string {
  return `${s.stopRef}|${s.stopName}`;
}

function decodeStopFromUrl(raw: string | null): StopSearchResult | null {
  if (!raw) return null;
  const sep = raw.indexOf("|");
  if (sep < 0) return null;
  const ref = raw.slice(0, sep);
  const name = raw.slice(sep + 1);
  if (!ref || !name) return null;
  if (ref.startsWith("coords:")) {
    const [lat, lng] = ref.slice(7).split(",").map(Number);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { stopRef: ref, stopPlaceRef: null, stopName: name, label: name, layer: "address", lat, lng };
  }
  return { stopRef: ref, stopPlaceRef: ref, stopName: name, label: name, layer: "venue", lat: null, lng: null };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TripPlanner() {
  const [location, navigate] = useLocation();
  const urlSearch = useSearch();
  const restoredFromUrl = useRef(false);

  const [fromStop, setFromStop] = useState<StopSearchResult | null>(null);
  const [toStop, setToStop] = useState<StopSearchResult | null>(null);
  const [fromQuery, setFromQuery] = useState("");
  const [toQuery, setToQuery] = useState("");
  const [tripPatterns, setTripPatterns] = useState<TripPattern[]>([]);
  const [delayStats, setDelayStats] = useState<Map<string, TripStopStat>>(new Map());
  const [showFilters, setShowFilters] = useState(false);
  // Entur-paginering: cursors for "tidligere avganger" / "senere avganger".
  const [pageCursors, setPageCursors] = useState<{ prev: string | null; next: string | null }>({
    prev: null,
    next: null,
  });
  // Hvilke reiseforslag som er utvidet (nøkkel = patternKey). Ligger her (ikke i
  // TripCard) slik at tilstanden overlever bytte av avgang på et legg.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  // Filter state
  const [departDate, setDepartDate] = useState(todayISO());
  const [departTime, setDepartTime] = useState(roundedNow());
  const [arriveBy, setArriveBy] = useState(false);
  const [walkSpeedKmh, setWalkSpeedKmh] = useState(5);
  // Probability-only filters (don't affect Entur routing):
  // - transferMarginMin: extra buffer the user wants on top of pure walk time (e.g. 5 min)
  // - sprintSpeedKmh: pace used when running the "spurt" scenario; defaults to walk speed
  //   so that a sprint = walking at the chosen pace + 30 sec margin, until user overrides.
  const [transferMarginMin, setTransferMarginMin] = useState(5);
  const [sprintSpeedKmh, setSprintSpeedKmh] = useState<number | null>(12);

  // Sprint speed must always be ≥ walk speed (you can't "sprint" slower than your walk).
  // When walk speed increases past the current sprint setting, bump sprint up to match.
  useEffect(() => {
    if (sprintSpeedKmh != null && sprintSpeedKmh < walkSpeedKmh) {
      setSprintSpeedKmh(walkSpeedKmh);
    }
  }, [walkSpeedKmh, sprintSpeedKmh]);

  const [maxTransfers, setMaxTransfers] = useState("any");
  const [transferSlack, setTransferSlack] = useState("default");
  const [selectedModes, setSelectedModes] = useState<string[]>(["bus", "tram", "rail", "metro", "water", "coach"]);
  const [wheelchairAccessible, setWheelchairAccessible] = useState(false);

  // Statistics time window filter
  const [statsTimeWindow, setStatsTimeWindow] = useState<StatsTimeWindow>({ type: "all" });

  // Hvilke persentil-kolonner som vises per stopp (alle på som standard)
  const [showPct, setShowPct] = useState({ p50: true, p80: true, p95: true });

  // DuckDB-WASM for empirical percentiles
  const { ready: duckReady, query: duckQuery, loading: duckLoading, idle: duckIdle, retry: duckRetry } = useParquetQuery();

  // ---------------------------------------------------------------------------
  // Overgangs-gap for ALLE reiseforslag, beregnet sekvensielt i bakgrunnen.
  // Utvidede kort prioriteres (typisk det øverste); resten fylles inn
  // topp-til-bunn slik at %-merkene dukker opp på sammenslåtte kort etter
  // hvert som de blir klare. Én DuckDB-rundtur per overgang (primær +
  // fallback UNION-et i samme spørring — se lib/trip-shared.ts).
  // ---------------------------------------------------------------------------
  const [gapResults, setGapResults] = useState<Map<string, Map<string, TransferGapResult>>>(new Map());
  const gapResultsRef = useRef(gapResults);
  gapResultsRef.current = gapResults;
  const gapGen = useRef(0);
  useEffect(() => {
    if (!duckReady || tripPatterns.length === 0) return;
    const gen = ++gapGen.current;
    const ordered = [...tripPatterns].sort(
      (a, b) =>
        (expandedKeys.has(patternKey(b)) ? 1 : 0) - (expandedKeys.has(patternKey(a)) ? 1 : 0),
    );
    (async () => {
      for (const p of ordered) {
        if (gapGen.current !== gen) return; // nytt søk/ny prioritering — avbryt
        const key = patternKey(p);
        if (gapResultsRef.current.has(key)) continue;
        const specs = buildTransferSpecsForPattern(p);
        try {
          const m = specs.length > 0
            ? await computeTransferGaps(specs, duckQuery)
            : new Map<string, TransferGapResult>();
          if (gapGen.current !== gen) return;
          setGapResults((prev) => new Map(prev).set(key, m));
        } catch (err) {
          // Forbigående DuckDB-/nettverksfeil: hopp over — kortet viser
          // "beregner…" og forsøkes igjen neste gang effekten kjører.
          if (import.meta.env.DEV) {
            console.warn("[trip] overgangs-gap feilet for", key, err);
          }
        }
      }
    })();
  }, [duckReady, tripPatterns, expandedKeys, duckQuery]);

  // Lat DuckDB-init: WASM-en (~7 MB gzippet) lastes IKKE ved sidelast lenger.
  // Start nedlastingen i det øyeblikket brukeren velger et stopp — da
  // overlapper den med at brukeren fyller ut resten av søket, og statistikken
  // er (som regel) klar når reiseforslagene kommer.
  useEffect(() => {
    if (fromStop || toStop) warmupDuckDB();
  }, [fromStop, toStop]);

  // Derive (stopRef, lineRef) pairs for DuckDB query from current trip results
  const duckPairs = useMemo(() => {
    const pairs: Array<{ stopRef: string; lineRef: string }> = [];
    const seen = new Set<string>();
    for (const p of tripPatterns) {
      for (const leg of p.legs) {
        const lineRef = leg.line?.id ?? "";
        if (!lineRef || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
        const quays = [
          leg.fromPlace.quay?.id,
          ...leg.intermediateQuays.map((q) => q.id),
          leg.toPlace.quay?.id,
        ].filter(Boolean) as string[];
        for (const q of quays) {
          const key = `${q}|${lineRef}`;
          if (!seen.has(key)) {
            seen.add(key);
            pairs.push({ stopRef: q, lineRef });
          }
        }
      }
    }
    return pairs;
  }, [tripPatterns]);

  const { data: duckData } = useTripDelayDistribution(duckPairs, duckReady, duckQuery);

  // Count total DuckDB observations for transparency display
  const duckObservationCount = useMemo(() => {
    if (!duckData) return 0;
    let total = 0;
    for (const row of Array.from(duckData.values())) {
      total += row.n ?? 0;
    }
    return total;
  }, [duckData]);

  // Datagrunnlagets omfang — vises i metodeboksen slik at "N dager" i
  // statistikken alltid kan sjekkes mot hva som faktisk er lastet.
  const { data: dataRange } = useQuery<{ days: number; min: string; max: string } | null>({
    queryKey: ["duck-data-range"],
    enabled: duckReady,
    staleTime: Infinity,
    queryFn: async () => {
      const rows = await duckQuery(
        `SELECT COUNT(DISTINCT date) AS days, MIN(date) AS mind, MAX(date) AS maxd FROM delays_by_stop`,
      );
      const r = rows[0] as { days: number; mind: string; maxd: string } | undefined;
      return r && Number(r.days) > 0
        ? { days: Number(r.days), min: String(r.mind), max: String(r.maxd) }
        : null;
    },
  });

  function toggleMode(mode: string) {
    setSelectedModes((prev) =>
      prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode],
    );
  }

  // Swap direction handler
  function swapDirection() {
    const oldFrom = fromStop;
    const oldTo = toStop;
    setFromStop(oldTo);
    setToStop(oldFrom);
    setFromQuery(oldTo?.stopName ?? "");
    setToQuery(oldFrom?.stopName ?? "");
  }

  const tripMutation = useMutation({
    mutationFn: async (opts?: { cursor: string; dir: "earlier" | "later" }) => {
      if (!fromStop || !toStop) throw new Error("Velg fra og til");
      warmupDuckDB(); // backstop — normalt allerede varmet ved stoppvalg

      // Build dateTime ISO string from date + time, with local timezone offset
      const localDate = new Date(`${departDate}T${departTime}:00`);
      const dateTime = localDate.toISOString();

      // 1. Build location refs — NSR:StopPlace for stops, coordinates for addresses
      function locationRef(stop: StopSearchResult) {
        if (stop.stopPlaceRef) return { place: stop.stopPlaceRef };
        if (stop.lat != null && stop.lng != null) return { coordinates: { latitude: stop.lat, longitude: stop.lng }, name: stop.stopName };
        return { place: stop.stopRef };
      }

      // Convert walk speed from km/h to m/s
      const walkSpeedMs = walkSpeedKmh / 3.6;

      // 2. Fetch trip from Entur
      const tripRes = await apiRequest("POST", "/api/trip", {
        from: locationRef(fromStop),
        to: locationRef(toStop),
        when: dateTime,
        arriveBy: arriveBy || undefined,
        transportModes: selectedModes.length > 0 ? selectedModes : undefined,
        walkSpeed: walkSpeedMs,
        // directMode: foot → Entur tar med et rent gå-alternativ i hovedlista
        // når det er realistisk (kort nok tur). Uten dette fikk man aldri se at
        // det raskere/like raske alternativet var å gå, med mindre man mistet
        // en overgang (fallback-kjeden bruker allerede directMode: foot).
        // Entur returnerer ikke urimelig lange gåturer, så dette er trygt å
        // alltid sende — brukerens egen ganghastighet styrer beregningen.
        directMode: "foot",
        maximumTransfers: maxTransfers !== "any" ? parseInt(maxTransfers) : undefined,
        transferSlack: transferSlack !== "default" ? parseInt(transferSlack) : undefined,
        wheelchairAccessible: wheelchairAccessible || undefined,
        numTripPatterns: 12, // hoytt tall -> Entur beregner dynamisk searchWindow riktig
        // Ved paginering overstyrer cursoren dateTime/searchWindow hos Entur
        pageCursor: opts?.cursor,
      });
      const tripData = await tripRes.json();

      // Surface errors from Entur (e.g. invalid parameters, no routes)
      if (tripData?.errors?.length) {
        const msg = tripData.errors.map((e: { message: string }) => e.message).join("; ");
        if (import.meta.env.DEV) {
          console.warn("[trip] Entur GraphQL errors:", tripData.errors);
        }
        throw new Error(`Entur: ${msg}`);
      }
      if (tripData?.error) {
        throw new Error(tripData.error + (tripData.detail ? ` — ${tripData.detail}` : ""));
      }

      const trip = tripData?.data?.trip;
      const patterns: TripPattern[] = trip?.tripPatterns ?? [];
      const cursors = {
        prev: (trip?.previousPageCursor as string | undefined) ?? null,
        next: (trip?.nextPageCursor as string | undefined) ?? null,
      };

      if (patterns.length === 0) {
        return { patterns: [], stats: new Map<string, TripStopStat>(), cursors };
      }

      // 2. Collect (stopRef, lineRef) pairs — only for modes where we have data
      const stopLinePairs = new Set<string>();
      for (const p of patterns) {
        for (const leg of p.legs) {
          const lineRef = leg.line?.id ?? "";
          if (!lineRef || !MODES_WITH_DELAY_DATA.has(leg.mode)) continue;
          const quays = [
            leg.fromPlace.quay?.id,
            ...leg.intermediateQuays.map((q) => q.id),
            leg.toPlace.quay?.id,
          ].filter(Boolean) as string[];
          for (const q of quays) {
            stopLinePairs.add(`${q}|${lineRef}`);
          }
        }
      }

      // 3. Fetch delay stats
      const stops = Array.from(stopLinePairs).map((key) => {
        const [stopRef, lineRef] = key.split("|");
        return { stopRef, lineRef };
      });

      let statsMap = new Map<string, TripStopStat>();
      if (stops.length > 0 && duckReady) {
        try {
          const conditions = stops
            .map((s) => `(stop_ref = '${s.stopRef.replace(/'/g, "''")}' AND line_ref = '${s.lineRef.replace(/'/g, "''")}')`)
            .join(" OR ");
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - 91);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          const statsData = await duckQuery<TripStopStat>(`
            SELECT
              stop_ref AS stopRef,
              line_ref AS lineRef,
              ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avgDelayMin,
              ROUND(AVG(delay_arrival_min), 2)   AS avgDelayArrivalMin,
              ROUND(AVG(delay_departure_min), 2)  AS avgDelayDepartureMin,
              COUNT(*) AS numSamples
            FROM delays_by_stop
            WHERE date >= '${cutoffStr}' AND (${conditions})
            GROUP BY stop_ref, line_ref`, undefined, { family: "by-stop", fromDate: cutoffStr });
          statsMap = new Map(statsData.map((s) => [`${s.stopRef}|${s.lineRef}`, s]));
        } catch (err) {
          if (import.meta.env.DEV) {
            console.warn("[trip] DuckDB forsinkelsesdata feilet, viser reise uten statistikk:", err);
          }
        }
      }

      return { patterns, stats: statsMap, cursors };
    },
    onSuccess: (data, variables) => {
      const dir = variables?.dir;
      if (dir === "earlier") {
        // Prepend nye (tidligere) forslag; behold vår "senere"-cursor
        setTripPatterns((prev) => dedupePatterns([...data.patterns, ...prev]));
        setPageCursors((pc) => ({ prev: data.cursors.prev, next: pc.next }));
        setDelayStats((prev) => new Map([...Array.from(prev), ...Array.from(data.stats)]));
      } else if (dir === "later") {
        setTripPatterns((prev) => dedupePatterns([...prev, ...data.patterns]));
        setPageCursors((pc) => ({ prev: pc.prev, next: data.cursors.next }));
        setDelayStats((prev) => new Map([...Array.from(prev), ...Array.from(data.stats)]));
      } else {
        setTripPatterns(data.patterns);
        setPageCursors(data.cursors);
        setDelayStats(data.stats);
        setExpandedKeys(
          new Set(data.patterns.length > 0 ? [patternKey(data.patterns[0])] : []),
        );
      }
    },
  });

  // Gjenopprett søk fra URL (?from=ref|navn&to=ref|navn&date=...&time=...&arriveBy=1)
  // — kjøres kun én gang ved mount. Trigger samme søk automatisk hvis begge
  // stopp ble gjenopprettet, slik at man ser resultatene igjen etter å ha
  // navigert bort og tilbake, ikke bare et forhåndsutfylt skjema.
  useEffect(() => {
    if (restoredFromUrl.current) return;
    restoredFromUrl.current = true;
    const params = new URLSearchParams(urlSearch);
    const from = decodeStopFromUrl(params.get("from"));
    const to = decodeStopFromUrl(params.get("to"));
    const date = params.get("date");
    const time = params.get("time");
    if (from) { setFromStop(from); setFromQuery(from.stopName); }
    if (to) { setToStop(to); setToQuery(to.stopName); }
    if (date) setDepartDate(date);
    if (time) setDepartTime(time);
    if (params.get("arriveBy") === "1") setArriveBy(true);
    if (from && to) {
      // setState er async — vent til neste tick slik at fromStop/toStop
      // faktisk er satt før mutationFn leser dem.
      setTimeout(() => tripMutation.mutate(undefined), 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Destinasjon som Entur Location-objekt — brukes av plan B/C/D-søk fra
  // overgangsstopp. Samme logikk som locationRef() i tripMutation.
  const destinationLocation = useMemo<Record<string, unknown> | null>(() => {
    if (!toStop) return null;
    if (toStop.stopPlaceRef) return { place: toStop.stopPlaceRef };
    if (toStop.lat != null && toStop.lng != null) {
      return { coordinates: { latitude: toStop.lat, longitude: toStop.lng }, name: toStop.stopName };
    }
    return { place: toStop.stopRef };
  }, [toStop]);

  // Bytt ut ett reiseforslag (etter "bytt avgang" på et legg), behold utvidet-status
  function handlePatternChange(idx: number, newPattern: TripPattern) {
    const oldKey = patternKey(tripPatterns[idx]);
    const newKey = patternKey(newPattern);
    setTripPatterns((prev) => prev.map((p, i) => (i === idx ? newPattern : p)));
    setExpandedKeys((prev) => {
      if (!prev.has(oldKey)) return prev;
      const s = new Set(prev);
      s.delete(oldKey);
      s.add(newKey);
      return s;
    });
  }

  const canSearch = fromStop != null && toStop != null && selectedModes.length > 0;

  return (
    <Layout>
      <div className="space-y-6 animate-in fade-in duration-500">
        <div>
          <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Navigation className="h-8 w-8 text-primary" /> Reiseplanlegger
          </h2>
          <p className="text-muted-foreground mt-1">
            Planlegg reisen din og se historiske forsinkelsesdata for hvert stopp.
          </p>
        </div>

        {/* Search form */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            {/* From / Swap / To / Button */}
            <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr_auto] items-end">
              <StopSearch label="Fra" value={fromStop} onSelect={(s) => { setFromStop(s); setFromQuery(s.stopName); }} externalQuery={fromQuery} />
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 self-end"
                onClick={swapDirection}
                title="Bytt retning"
              >
                <ArrowUpDown className="h-4 w-4" />
              </Button>
              <StopSearch label="Til" value={toStop} onSelect={(s) => { setToStop(s); setToQuery(s.stopName); }} externalQuery={toQuery} />
              <div className="flex items-end">
                <Button
                  onClick={() => {
                    // Lagre søket i URL-en (for refresh/deling og for at det
                    // består om man navigerer bort og tilbake) før søket kjøres.
                    if (fromStop && toStop) {
                      const params = new URLSearchParams();
                      params.set("from", encodeStopForUrl(fromStop));
                      params.set("to", encodeStopForUrl(toStop));
                      params.set("date", departDate);
                      params.set("time", departTime);
                      if (arriveBy) params.set("arriveBy", "1");
                      navigate(`${location}?${params.toString()}`, { replace: true });
                    }
                    tripMutation.mutate(undefined);
                  }}
                  disabled={!canSearch || tripMutation.isPending}
                  className="w-full md:w-auto"
                >
                  {tripMutation.isPending ? "Leter..." : "Finn reise"}
                </Button>
              </div>
            </div>

            {/* Date / Time / Direction */}
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <div>
                <Label className="text-xs text-muted-foreground">Dato</Label>
                <Input
                  type="date"
                  value={departDate}
                  onChange={(e) => setDepartDate(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Tid</Label>
                <Input
                  type="time"
                  value={departTime}
                  onChange={(e) => setDepartTime(e.target.value)}
                  className="h-9 text-sm"
                  step="300"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Retning</Label>
                <Select value={arriveBy ? "arrive" : "depart"} onValueChange={(v) => setArriveBy(v === "arrive")}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="depart">Avgang</SelectItem>
                    <SelectItem value="arrive">Ankomst</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  <ArrowDownUp className="h-3 w-3" />
                  {showFilters ? "Skjul filtre" : "Flere filtre"}
                </Button>
              </div>
            </div>

            {/* Advanced filters — collapsible */}
            {showFilters && (
              <div className="border-t pt-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
                {/* Transport modes */}
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Transportmidler</Label>
                  <div className="flex flex-wrap gap-2">
                    {TRANSPORT_MODE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => toggleMode(opt.value)}
                        className={cn(
                          "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                          selectedModes.includes(opt.value)
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-muted/50 text-muted-foreground border-border hover:bg-muted",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                  {/* Walking speed slider */}
                  <div className="col-span-2 md:col-span-1">
                    <Label className="text-xs text-muted-foreground">
                      Ganghastighet: {walkSpeedKmh.toFixed(1)} km/t
                    </Label>
                    <div className="pt-2 px-1">
                      <Slider
                        value={[walkSpeedKmh]}
                        onValueChange={(v) => setWalkSpeedKmh(v[0])}
                        min={0}
                        max={20}
                        step={0.1}
                      />
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground/60 mt-1">
                      <span>0</span>
                      <span>10</span>
                      <span>20 km/t</span>
                    </div>
                  </div>

                  {/* Sprint speed slider — affects only "spurt"-overgangssannsynlighet */}
                  <div className="col-span-2 md:col-span-1">
                    <Label className="text-xs text-muted-foreground">
                      Spurt-tempo: {(sprintSpeedKmh ?? walkSpeedKmh).toFixed(1)} km/t
                    </Label>
                    <div className="pt-2 px-1">
                      <Slider
                        value={[sprintSpeedKmh ?? walkSpeedKmh]}
                        onValueChange={(v) => setSprintSpeedKmh(v[0])}
                        min={walkSpeedKmh}
                        max={20}
                        step={0.1}
                      />
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground/60 mt-1">
                      <span>{walkSpeedKmh.toFixed(0)}</span>
                      <span>{((walkSpeedKmh + 20) / 2).toFixed(0)}</span>
                      <span>20 km/t</span>
                    </div>
                  </div>

                  {/* User transfer margin — only affects probability shown, not Entur routing */}
                  <div className="col-span-2 md:col-span-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      Overgangsmargin: {transferMarginMin} min
                      <InfoTip>
                        Hvor mye slark <strong>du</strong> vil ha utover ren gangtid ved bytte.
                        Påvirker <strong>kun sannsynligheten</strong> som vises («Med {transferMarginMin} min
                        margin») — den endrer ikke hvilke reiser du får opp. Sendes ikke til Entur.
                      </InfoTip>
                    </Label>
                    <div className="pt-2 px-1">
                      <Slider
                        value={[transferMarginMin]}
                        onValueChange={(v) => setTransferMarginMin(v[0])}
                        min={0}
                        max={15}
                        step={1}
                      />
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground/60 mt-1">
                      <span>0</span>
                      <span>5</span>
                      <span>15 min</span>
                    </div>
                  </div>

                  {/* Max transfers */}
                  <div>
                    <Label className="text-xs text-muted-foreground">Maks overganger</Label>
                    <Select value={maxTransfers} onValueChange={setMaxTransfers}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Ubegrenset</SelectItem>
                        <SelectItem value="0">Direkte</SelectItem>
                        <SelectItem value="1">1 overgang</SelectItem>
                        <SelectItem value="2">2 overganger</SelectItem>
                        <SelectItem value="3">3 overganger</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Transfer slack — sendes til Entur, styrer HVILKE reiser vi får */}
                  <div>
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      Overgangstid
                      <InfoTip>
                        Minste byttetid <strong>Entur</strong> godtar når de setter sammen
                        reiseforslag. Sendes til Journey Planner API-et og endrer{" "}
                        <strong>hvilke reiser du får opp</strong> — høyere verdi gir færre, men
                        romsligere overganger. Lav/negativ verdi gir også de knappe byttene.
                      </InfoTip>
                    </Label>
                    <Select value={transferSlack} onValueChange={setTransferSlack}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Standard (2 min)</SelectItem>
                        <SelectItem value="-60">-1 min (sprinter)</SelectItem>
                        <SelectItem value="0">0 sek</SelectItem>
                        <SelectItem value="30">30 sek</SelectItem>
                        <SelectItem value="60">1 min</SelectItem>
                        <SelectItem value="180">3 min</SelectItem>
                        <SelectItem value="300">5 min (trygt)</SelectItem>
                        <SelectItem value="600">10 min (ekstra trygt)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Wheelchair */}
                  <div className="flex items-end">
                    <button
                      onClick={() => setWheelchairAccessible(!wheelchairAccessible)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-md text-xs border transition-colors w-full h-9",
                        wheelchairAccessible
                          ? "bg-primary/10 text-primary border-primary/30"
                          : "bg-muted/50 text-muted-foreground border-border hover:bg-muted",
                      )}
                    >
                      <Accessibility className="h-4 w-4" />
                      Universell utforming
                    </button>
                  </div>
                </div>

                {/* Statistics time window filter */}
                <div className="border-t pt-4">
                  <Label className="text-xs text-muted-foreground mb-2 block flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Statistikkperiode (pavirker kun forsinkelsesdata, ikke reiseforslag)
                  </Label>
                  <div className="flex flex-wrap gap-2">
                    {([
                      { type: "all" as const, label: "Alle data" },
                      { type: "days" as const, value: 7, label: "Siste 7 dager" },
                      { type: "days" as const, value: 30, label: "Siste 30 dager" },
                      { type: "days" as const, value: 90, label: "Siste 90 dager" },
                      { type: "weekday" as const, label: "Ukedager" },
                      { type: "weekend" as const, label: "Helg" },
                      { type: "custom" as const, label: "Egne datoer" },
                    ] as const).map((opt) => {
                      const isActive = statsTimeWindow.type === opt.type &&
                        (opt.type !== "days" || statsTimeWindow.value === opt.value);
                      return (
                        <button
                          key={`${opt.type}-${opt.type === "days" ? opt.value : ""}`}
                          onClick={() => {
                            if (opt.type === "days") {
                              setStatsTimeWindow({ type: "days", value: opt.value });
                            } else {
                              setStatsTimeWindow({ type: opt.type });
                            }
                          }}
                          className={cn(
                            "px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                            isActive
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-muted/50 text-muted-foreground border-border hover:bg-muted",
                          )}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  {statsTimeWindow.type === "custom" && (
                    <div className="flex gap-3 mt-3">
                      <div>
                        <Label className="text-xs text-muted-foreground">Fra dato</Label>
                        <Input
                          type="date"
                          value={statsTimeWindow.dateFrom ?? ""}
                          onChange={(e) => setStatsTimeWindow((prev) => ({ ...prev, dateFrom: e.target.value }))}
                          className="h-9 text-sm"
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Til dato</Label>
                        <Input
                          type="date"
                          value={statsTimeWindow.dateTo ?? ""}
                          onChange={(e) => setStatsTimeWindow((prev) => ({ ...prev, dateTo: e.target.value }))}
                          className="h-9 text-sm"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tripMutation.isError && (
              <p className="text-destructive text-sm flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" />
                {(tripMutation.error as Error).message}
              </p>
            )}
          </CardContent>
        </Card>

        {tripMutation.isPending && tripPatterns.length === 0 && (
          <div className="flex justify-center py-8">
            <BusLoading label="Leter etter reiseforslag" scale={0.7} />
          </div>
        )}

        {/* Results */}
        {tripPatterns.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-lg font-semibold">
                {tripPatterns.length} reiseforslag
                {delayStats.size > 0 && (
                  <span className="text-sm font-normal text-muted-foreground ml-2">
                    med historiske forsinkelsesdata
                  </span>
                )}
              </h3>
              {/* Persentil-velger: styrer hvilke estimatkolonner som vises per stopp */}
              <div className="flex items-center gap-3 text-xs">
                <span className="text-muted-foreground">Vis estimater:</span>
                {([
                  ["p50", "~P50", "text-amber-500", "Median — halvparten av avgangene er innenfor"],
                  ["p80", "P80", "text-red-500/80", "4 av 5 avganger er innenfor"],
                  ["p95", "P95", "text-violet-500/80", "19 av 20 avganger er innenfor"],
                ] as const).map(([key, label, color, title]) => (
                  <label key={key} className="flex items-center gap-1.5 cursor-pointer" title={title}>
                    <Checkbox
                      checked={showPct[key]}
                      onCheckedChange={(c) =>
                        setShowPct((prev) => ({ ...prev, [key]: c === true }))
                      }
                    />
                    <span className={cn("font-mono", color)}>{label}</span>
                  </label>
                ))}
              </div>
            </div>
            {pageCursors.prev && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={tripMutation.isPending}
                onClick={() => tripMutation.mutate({ cursor: pageCursors.prev!, dir: "earlier" })}
              >
                <ChevronUp className="h-4 w-4 mr-1.5" />
                {tripMutation.isPending ? "Leter..." : "Tidligere avganger"}
              </Button>
            )}
            {tripPatterns.map((pattern, i) => (
              <TripCard
                key={patternKey(pattern)}
                pattern={pattern}
                index={i}
                stats={delayStats}
                duckStats={duckData}
                transferMarginMin={transferMarginMin}
                walkSpeedKmh={walkSpeedKmh}
                sprintSpeedKmh={sprintSpeedKmh ?? walkSpeedKmh}
                duckReady={duckReady}
                duckQuery={duckQuery}
                expanded={expandedKeys.has(patternKey(pattern))}
                onToggleExpanded={() => {
                  const k = patternKey(pattern);
                  setExpandedKeys((prev) => {
                    const s = new Set(prev);
                    if (s.has(k)) s.delete(k);
                    else s.add(k);
                    return s;
                  });
                }}
                onPatternChange={(newPattern) => handlePatternChange(i, newPattern)}
                destination={destinationLocation}
                selectedModes={selectedModes}
                gapMap={gapResults.get(patternKey(pattern))}
                showPct={showPct}
              />
            ))}
            {pageCursors.next && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={tripMutation.isPending}
                onClick={() => tripMutation.mutate({ cursor: pageCursors.next!, dir: "later" })}
              >
                <ChevronDown className="h-4 w-4 mr-1.5" />
                {tripMutation.isPending ? "Leter..." : "Senere avganger"}
              </Button>
            )}
          </div>
        )}

        {tripPatterns.length === 0 && !tripMutation.isPending && tripMutation.isSuccess && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <p>Ingen reiseforslag funnet. Prøv andre stoppesteder eller juster filtrene.</p>
            </CardContent>
          </Card>
        )}

        {/* Methodology info box */}
        <Card className="bg-muted/20 border-muted">
          <CardContent className="pt-5 pb-4 text-xs text-muted-foreground space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Info className="h-4 w-4 text-primary" />
                Slik beregner vi tallene
              </h3>
              <div className="flex items-center gap-2">
                <span className={cn(
                  "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border",
                  duckReady
                    ? "text-green-600 border-green-300 bg-green-50 dark:bg-green-950/20"
                    : duckLoading
                    ? "text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/20"
                    : !duckIdle
                    ? "text-red-600 border-red-300 bg-red-50 dark:bg-red-950/20"
                    : "text-muted-foreground border-border"
                )}>
                  <Database className="h-3 w-3" />
                  {duckReady
                    ? "Statistikk klar"
                    : duckLoading
                    ? "Laster statistikk…"
                    : duckIdle
                    ? "Statistikk lastes ved søk"
                    : "Statistikk utilgjengelig akkurat nå"}
                </span>
                {!duckReady && !duckLoading && !duckIdle && (
                  <button
                    type="button"
                    onClick={duckRetry}
                    className="text-[10px] text-primary hover:underline"
                    title="Prøv å laste de historiske dataene på nytt"
                  >
                    Prøv igjen
                  </button>
                )}
                {duckObservationCount > 0 && (
                  <span className="text-[10px] text-muted-foreground/70">
                    {duckObservationCount.toLocaleString("nb-NO")} obs.
                  </span>
                )}
                {dataRange && (
                  <span
                    className="text-[10px] text-muted-foreground/70"
                    title="Antall dager med rådata som er lastet i nettleseren — alle 'N dager'-tall i statistikken er begrenset av dette"
                  >
                    Datagrunnlag: {dataRange.days} dager (
                    {new Date(dataRange.min).toLocaleDateString("nb-NO", { day: "numeric", month: "short" })}
                    –
                    {new Date(dataRange.max).toLocaleDateString("nb-NO", { day: "numeric", month: "short" })}
                    )
                  </span>
                )}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {/* Reiseforslag */}
              <div className="space-y-1">
                <p className="font-medium text-foreground/80">Reiseforslag</p>
                <p>Hentet fra Entur Journey Planner API v3 (NLOD 2.0). Tidene er planlagte rutetider fra Entur.</p>
              </div>

              {/* Estimert tid */}
              <div className="space-y-1">
                <p className="font-medium text-foreground/80 flex items-center gap-1">
                  <span className="text-amber-500 font-mono">~HH:MM</span> Estimert tid
                </p>
                <p>Rutetid + median historisk forsinkelse (P50) for avgangen ved det aktuelle stoppet. Regnet ut direkte i nettleseren din fra historiske data — ingen tall sendes til en server.</p>
              </div>

              {/* Sannsynlighet for overgang */}
              <div className="space-y-1">
                <p className="font-medium text-foreground/80 flex items-center gap-1">
                  <span className="text-green-600 font-mono">X%</span> Sannsynlighet for å rekke bytte
                </p>
                <p>Telt opp dag for dag i historikken: for hver historisk dag (med samme dagtype) der begge dine avganger faktisk gikk, måler vi det faktiske gapet mellom ankomst og neste avgang, og teller hvor mange dager marginen var stor nok (inkl. din gangtid). Avgangen din gjenkjennes på tvers av dager via en stabil avgangs-ID — eller eksakt rutetid når ID-en er fersk. Har vi få dager på din egen avgang, viser vi i tillegg <em>sammenlignbare</em> naboavganger; begge tallene står side om side i overgangsanalysen med antall dager, så du ser hvor sikkert grunnlaget er. Se <a href="/metode#overgang" className="text-primary hover:underline">metodesiden</a> for detaljer.</p>
              </div>

              {/* P80 punktlighet */}
              <div className="space-y-1">
                <p className="font-medium text-foreground/80 flex items-center gap-1">
                  <span className="text-muted-foreground font-mono">P80</span> Punktlighet
                </p>
                <p>80. persentil av forsinkelsen — 80 % av de historiske turene var innenfor denne forsinkelsen. Regnet ut fra de rå historiske observasjonene, direkte i nettleseren din.</p>
              </div>
            </div>

            <div className="border-t pt-3 space-y-2">
              <div className="flex items-start gap-2">
                <CheckCircle className="h-3 w-3 text-green-500 mt-0.5 flex-shrink-0" />
                <p><strong>Datakilde:</strong> Sanntidsdata fra SIRI ET (Entur). Forsinkelse = faktisk tid − planlagt tid. Buss og flybuss fra operatører med SIRI ET-feed har forsinkelsesdata. Andre transportmidler vises uten statistikk.</p>
              </div>
              <div className="flex items-start gap-2">
                <Calendar className="h-3 w-3 text-primary mt-0.5 flex-shrink-0" />
                <p><strong>Tidsvindu-filter:</strong> Påvirker kun forsinkelsesstatistikken, ikke reiseforslagene fra Entur.</p>
              </div>
              <div className="flex items-start gap-2">
                <Database className="h-3 w-3 text-primary mt-0.5 flex-shrink-0" />
                <p><strong>Teknisk:</strong> Forsinkelsesdata eksporteres nattlig som ukentlige Parquet-filer (ZSTD) til Cloudflare R2, og analyseres med DuckDB-WASM direkte i nettleseren. De siste 14 ukene beholdes. Ingen data sendes tilbake til serveren.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
