import { Link } from "wouter";
import { Users, ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  PAX_ENABLED, PAX_SOURCE, isPaxOperator, lineOperator, usePaxSummary, fmtInt, fmtMin, formatMonthLong, crowdLevel,
} from "@/lib/pax";
import { cn } from "@/lib/utils";

/**
 * Passasjertall for én linje i Linjeanalyse — kort oppsummering med lenke til
 * /passasjerer. Rendrer ingenting for operatører uten tellinger, eller når
 * passasjerfunksjonen er av.
 */
export function LinePaxCard({ lineRef }: { lineRef: string | null | undefined }) {
  const covered = PAX_ENABLED && isPaxOperator(lineOperator(lineRef));
  const { data: summary } = usePaxSummary();
  if (!covered || !summary || !lineRef) return null;
  const l = summary.lines.find((x) => x.lineRef === lineRef);
  if (!l) return null;
  const lvl = crowdLevel(l.peakP90);

  return (
    <Card className="border-l-4 border-l-primary/60 bg-primary/[0.03]">
      <CardContent className="py-4 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4 text-primary" />
          Passasjerer i {formatMonthLong(l.month)}
          <span className="text-[10px] uppercase tracking-wide rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 px-1.5 py-0.5">beta</span>
          <a href={PAX_SOURCE.url} target="_blank" rel="noopener noreferrer" className="text-[11px] font-normal text-muted-foreground underline">
            kilde: samferdselsdata.no
          </a>
        </div>
        <Stat label="Påstigninger" value={fmtInt(l.boardings)} />
        <Stat label="Merket forsinkelse" value={fmtMin(l.paxDelay)} hint={`per avgang ${fmtMin(l.stopDelay)}`} />
        <Stat label="Passasjertimer tapt" value={fmtInt(l.paxHoursLost)} />
        {l.peakP90 != null && (
          <div className="text-xs">
            <div className="text-muted-foreground">9 av 10 avganger</div>
            <span className={cn("inline-block mt-0.5 rounded-full border px-2 py-0.5", lvl?.className)}>
              under {Math.round(l.peakP90)} om bord
            </span>
          </div>
        )}
        <Link
          href={`/passasjerer?op=${l.op}&line=${encodeURIComponent(l.lineRef)}`}
          className="ml-auto inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          Belegg avgang for avgang <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono font-semibold text-base text-foreground">{value}</div>
      {hint && <div className="text-muted-foreground">{hint}</div>}
    </div>
  );
}
