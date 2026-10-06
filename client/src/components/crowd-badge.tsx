import { Users } from "lucide-react";
import { Link } from "wouter";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { computeDayType } from "@/lib/day-type";
import type { TripLeg } from "@/lib/trip-shared";
import {
  PAX_ENABLED, PAX_SOURCE, isPaxOperator, lineOperator, usePaxLine, legLoad, crowdLevel, formatMonthLong, paxDepKey,
  type PaxLine,
} from "@/lib/pax";

/** Planlagt avgang fra påstigningsstoppet, som Date (fra passingTimes). */
function aimedStartOf(leg: TripLeg): Date {
  const q = leg.fromPlace.quay?.id;
  const pt = q ? leg.serviceJourney?.passingTimes.find((p) => p.quay?.id === q) : undefined;
  const t = pt?.departure?.time ?? pt?.arrival?.time;
  const d = new Date(leg.expectedStartTime);
  if (t) {
    const [h, m] = t.split(":").map(Number);
    d.setHours(h, m, 0, 0);
  }
  return d;
}

/**
 * «Hvor full er bussen?» for ett reiselegg. Rendrer ingenting når funksjonen
 * er av, operatøren ikke har passasjertall, eller avgangen ikke finnes i
 * tellingene — fravær av merke betyr «vet ikke», aldri «tomt».
 */
export function LegCrowdBadge({ leg, compact = false }: { leg: TripLeg; compact?: boolean }) {
  const lineRef = leg.line?.id ?? null;
  const covered = PAX_ENABLED && isPaxOperator(lineOperator(lineRef));
  const { data: line } = usePaxLine(covered ? lineRef : null);
  if (!covered || !line || !leg.fromPlace.quay?.id || !leg.toPlace.quay?.id) return null;

  const res = legLoad(line, {
    sjId: leg.serviceJourney?.id ?? null,
    fromQuay: leg.fromPlace.quay.id,
    toQuay: leg.toPlace.quay.id,
    aimedStart: aimedStartOf(leg),
    dayType: computeDayType(leg.expectedStartTime),
  });
  if (!res) return null;
  const lvl = crowdLevel(res.peak);
  if (!lvl) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
            lvl.className,
          )}
        >
          <Users className="h-2.5 w-2.5" />
          {compact ? lvl.short : (
            <>
              <span className="sm:hidden">{lvl.short}</span>
              <span className="hidden sm:inline">{lvl.label} · ~{Math.round(res.peak)}</span>
            </>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs space-y-1">
        <p>
          Typisk <strong>{Math.round(res.peak)}</strong> om bord på det fulleste mellom {leg.fromPlace.name} og{" "}
          {leg.toPlace.name} (snitt {Math.round(res.avg)}).
        </p>
        <p className="text-muted-foreground">
          {res.match === "exact" ? "Samme avgang" : "Nærmeste avgang på samme tid"} i{" "}
          {formatMonthLong(res.month)}
          {res.runs != null ? `, snitt over ${Math.round(res.runs)} turer` : ""}. Kilde: passasjertellinger (beta) fra{" "}
          <a href={PAX_SOURCE.url} target="_blank" rel="noopener noreferrer" className="underline">samferdselsdata.no</a>{" "}
          (Entur). Tellinger kan ha feil.
          {lvl.key === "multi" && " Over 120 betyr nesten alltid at flere busser kjører på samme avgang."}
        </p>
        <Link href={`/passasjerer?op=${lineOperator(lineRef)}&line=${encodeURIComponent(lineRef!)}&dep=${encodeURIComponent(res.dep.k)}`} className="underline">
          Se hele avgangen →
        </Link>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Belegg når en avgang KJØRER FRA et stopp (om bord etter at folk har gått av
 * og på her) — for avgangstavla. Det er det som avgjør om du får sitteplass
 * og hvor trangt det er videre; «når bussen kommer» er alltid 0 ved
 * endeholdeplassen og sier lite. Matcher på avgangsnøkkel, ellers nærmeste
 * avgang samme dagtype (±6 min) som stopper her.
 */
export function loadDepartingFrom(
  line: PaxLine,
  opts: { sjId?: string | null; quay: string; aimed: Date },
): { load: number; match: "exact" | "nearby" } | null {
  const qi = line.stops.findIndex((s) => s[0] === opts.quay);
  if (qi < 0) return null;
  const dayType = computeDayType(opts.aimed);
  const target = opts.aimed.getHours() * 60 + opts.aimed.getMinutes();
  const pick = (dep: PaxLine["deps"][number]) => {
    const i = dep.s.indexOf(qi);
    if (i < 0) return null;
    const v = dep.l[i];
    return v == null ? null : v;
  };
  if (opts.sjId) {
    const key = paxDepKey(opts.sjId);
    const cands = line.deps.filter((d) => d.k === key);
    const d = cands.find((x) => x.dt === dayType) ?? cands[0];
    const v = d ? pick(d) : null;
    if (v != null) return { load: v, match: "exact" };
  }
  let best: { v: number; diff: number } | null = null;
  for (const d of line.deps) {
    if (d.dt !== dayType || !d.t) continue;
    const i = d.s.indexOf(qi);
    if (i < 0 || d.o[i] == null) continue;
    const at = (Number(d.t.slice(0, 2)) * 60 + Number(d.t.slice(3, 5)) + d.o[i]!) % 1440;
    const diff = Math.min(Math.abs(at - target), 1440 - Math.abs(at - target));
    const v = pick(d);
    if (v != null && diff <= 6 && (!best || diff < best.diff)) best = { v, diff };
  }
  return best ? { load: best.v, match: "nearby" } : null;
}

/** Lite «~N om bord»-merke til avgangstavla. */
export function DepartingLoadBadge({ lineRef, sjId, quay, aimed }: {
  lineRef: string | null | undefined; sjId?: string | null; quay: string | null | undefined; aimed: string | Date | null | undefined;
}) {
  const covered = PAX_ENABLED && isPaxOperator(lineOperator(lineRef));
  const { data: line } = usePaxLine(covered ? lineRef : null);
  if (!covered || !line || !quay || !aimed) return null;
  const res = loadDepartingFrom(line, { sjId, quay, aimed: typeof aimed === "string" ? new Date(aimed) : aimed });
  if (!res) return null;
  const lvl = crowdLevel(res.load);
  if (!lvl) return null;
  return (
    <span
      title={`Typisk ${Math.round(res.load)} om bord når bussen kjører herfra (${res.match === "exact" ? "samme avgang" : "nærmeste avgang"}, snitt ${formatMonthLong(line.month)}). Kilde: passasjertellinger (beta), samferdselsdata.no / Entur. Tellinger kan ha feil.`}
      className={cn("inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[10px] font-mono tabular-nums whitespace-nowrap", lvl.className)}
    >
      <Users className="h-2.5 w-2.5" />~{Math.round(res.load)}
    </span>
  );
}
