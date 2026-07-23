// ---------------------------------------------------------------------------
// Hele avgangen (serviceJourney) med forsinkelsestall per stopp.
//
// Vises i reiseplanleggeren når man klikker på linjenummeret/-navnet i et
// legg: HELE ruten til avgangen (ikke bare den delen reisen bruker), med
// rutetid, sanntid og historiske persentiler (P50/P80/P95) per stopp.
// Perrong/plattform vises tydelig per stopp.
//
// Persentilkolonnene styres av de samme avkryssingsboksene som resten av
// reiseplanleggeren (showPct-prop).
// ---------------------------------------------------------------------------

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { BusLoading } from "@/components/bus-loading";
import { cn } from "@/lib/utils";
import { escSql, type DuckQueryFn } from "@/lib/trip-shared";

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

type SjStopStat = {
  stop_ref: string;
  p50_dep: number | null;
  p80_dep: number | null;
  p95_dep: number | null;
  p50_arr: number | null;
  p80_arr: number | null;
  p95_arr: number | null;
  n: number;
  source: "sj" | "line";
};

function fmtHM(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function addMinToIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + Math.round(minutes));
  return d.toISOString();
}

function delayBadgeClass(delayMin: number | null): string {
  if (delayMin == null) return "";
  if (delayMin <= 1) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (delayMin <= 4) return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30";
}

function fmtDeltaMin(m: number): string {
  if (m === 0) return "i rute";
  return m > 0 ? `+${m}m` : `${m}m`;
}

/**
 * mounted-og-alltid-fetch: queryene kjører så snart komponenten er montert
 * (så lenge `active`), uavhengig av om `open`. Slik prefetches hele avgangen i
 * bakgrunnen for hvert legg i et utvidet kort, og visningen er umiddelbar når
 * brukeren klikker. Selve tabellen rendres bare når `open`.
 */
export function ServiceJourneyDetail({
  sjId,
  dateIso,
  lineRef,
  highlightFromQuay,
  highlightToQuay,
  open,
  active,
  showPct,
  duckReady,
  duckQuery,
}: {
  sjId: string;
  dateIso: string; // ISO for avgangen (brukes for dato i SJ-spørringen)
  lineRef: string | null;
  highlightFromQuay: string | null; // reisens påstigning (markeres)
  highlightToQuay: string | null;   // reisens avstigning (markeres)
  open: boolean;
  active: boolean; // prefetch kun for utvidede kort
  showPct: { p50: boolean; p80: boolean; p95: boolean };
  duckReady: boolean;
  duckQuery: DuckQueryFn;
}) {
  const date = dateIso.slice(0, 10);
  const { data: sj, isLoading, isError } = useQuery<SjResponse>({
    queryKey: [`/api/servicejourney/${encodeURIComponent(sjId)}?date=${date}`],
    enabled: active,
    staleTime: 60_000,
  });

  // Per-stopp P50/P80/P95 fra DuckDB: helst for akkurat denne avgangen
  // (service_journey_id), ellers for linjen ved stoppet (bredest dekning).
  const { data: statMap } = useQuery<Map<string, SjStopStat>>({
    queryKey: ["duck-sj-stops-full", sjId, lineRef ?? ""],
    enabled: active && duckReady,
    staleTime: Infinity,
    queryFn: async () => {
      const map = new Map<string, SjStopStat>();
      const cols = `
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_departure_min) AS p50_dep,
        PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_departure_min) AS p80_dep,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_departure_min) AS p95_dep,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_arrival_min)   AS p50_arr,
        PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_arrival_min)   AS p80_arr,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_arrival_min)   AS p95_arr,
        COUNT(*) AS n`;
      if (lineRef) {
        const lineRows = await duckQuery(`
          SELECT stop_ref, ${cols} FROM delays_by_line
          WHERE line_ref = '${escSql(lineRef)}'
          GROUP BY stop_ref`, undefined, { family: "by-line" }) as Array<Omit<SjStopStat, "source">>;
        for (const r of lineRows) map.set(r.stop_ref, { ...r, source: "line" });
      }
      const sjRows = await duckQuery(`
        SELECT stop_ref, ${cols} FROM delays_by_line
        WHERE service_journey_id = '${escSql(sjId)}'
        GROUP BY stop_ref`, undefined, { family: "by-line" }) as Array<Omit<SjStopStat, "source">>;
      for (const r of sjRows) {
        if (r.n >= 3) map.set(r.stop_ref, { ...r, source: "sj" });
      }
      return map;
    },
  });

  if (!open) return null;

  if (isLoading) {
    return (
      <div className="py-2 pl-4">
        <BusLoading label="Henter hele avgangen" scale={0.42} />
      </div>
    );
  }
  if (isError || !sj || sj.calls.length === 0) {
    return <div className="py-3 pl-4 text-xs text-muted-foreground">Fant ikke stopplisten for denne avgangen.</div>;
  }

  const anySj = Array.from(statMap?.values() ?? []).some((s) => s.source === "sj");
  const anyPct = showPct.p50 || showPct.p80 || showPct.p95;

  return (
    <div className="mt-2 mb-1 py-2 pl-3 pr-2 bg-muted/20 rounded-md border-l-2 border-primary/20">
      <div className="text-[10px] text-muted-foreground mb-1.5 flex items-center gap-2 flex-wrap">
        <span className="font-medium">
          Linje {sj.line?.publicCode ?? "?"} · hele avgangen ({sj.calls.length} stopp)
        </span>
        <span>Rutetid</span>
        <span className="text-emerald-600">sanntid</span>
        {showPct.p50 && <span className="text-amber-500">~P50</span>}
        {showPct.p80 && <span className="text-red-500/80">P80</span>}
        {showPct.p95 && <span className="text-violet-500/80">P95</span>}
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
          const p95 = isLast ? stat?.p95_arr : stat?.p95_dep;
          // Marker reisens egen strekning (påstigning → avstigning)
          const isBoard = c.quayRef != null && c.quayRef === highlightFromQuay;
          const isAlight = c.quayRef != null && c.quayRef === highlightToQuay;
          return (
            <div
              key={`${c.quayRef ?? "q"}-${i}`}
              className={cn(
                "flex items-center gap-2 text-xs py-0.5 px-1 rounded",
                (isBoard || isAlight) && "bg-primary/10 font-medium",
                c.cancelled && "opacity-60 line-through",
              )}
            >
              <div className={cn(
                "w-1.5 h-1.5 rounded-full flex-shrink-0",
                isBoard || isAlight ? "bg-primary" : "bg-muted-foreground/40",
              )} />
              <span className="flex-1 truncate">
                {c.quayName ?? "—"}
                {isBoard && <span className="text-[9px] text-primary ml-1">(på)</span>}
                {isAlight && <span className="text-[9px] text-primary ml-1">(av)</span>}
              </span>
              {/* Perrong/plattform — tydelig markert */}
              {c.platform ? (
                <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono flex-shrink-0" title="Perrong">
                  Perrong {c.platform}
                </Badge>
              ) : (
                <span className="w-4" />
              )}
              <span className="font-mono text-[11px] tabular-nums w-10 text-right">{fmtHM(aimed)}</span>
              {rtDelta != null ? (
                <Badge variant="outline" className={cn("font-mono text-[9px] px-1 py-0", delayBadgeClass(rtDelta))}>
                  {fmtDeltaMin(rtDelta)}
                </Badge>
              ) : (
                <span className="w-8 text-center text-[9px] text-muted-foreground/40">—</span>
              )}
              {showPct.p50 && (
                <span className="font-mono text-[10px] tabular-nums text-amber-500 w-12 text-right">
                  {aimed && p50 != null ? `~${fmtHM(addMinToIso(aimed, p50))}` : ""}
                </span>
              )}
              {showPct.p80 && (
                <span className="font-mono text-[10px] tabular-nums text-red-500/80 w-11 text-right">
                  {aimed && p80 != null ? fmtHM(addMinToIso(aimed, p80)) : ""}
                </span>
              )}
              {showPct.p95 && (
                <span className="font-mono text-[10px] tabular-nums text-violet-500/80 w-11 text-right">
                  {aimed && p95 != null ? fmtHM(addMinToIso(aimed, p95)) : ""}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {!anyPct && (
        <p className="text-[10px] text-muted-foreground/60 italic mt-1.5">
          Kryss av P50/P80/P95 over resultatlista for å vise historiske estimater per stopp.
        </p>
      )}
      {duckReady && (!statMap || statMap.size === 0) && (
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
