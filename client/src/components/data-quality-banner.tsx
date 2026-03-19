import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronUp, Clock, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface DataQualityWarning {
  id: number;
  type: "outlier_delay" | "missing_time";
  lineRef: string | null;
  serviceJourneyId: string | null;
  stopRef: string | null;
  aimedTime: string | null;
  delayMin: number | null;
  count: number;
  total: number | null;
  message: string;
}

interface Props {
  date: string;
  operator?: string;
  lineRef?: string;
  stopRef?: string;
  className?: string;
}

function formatLineRef(lineRef: string | null): string {
  if (!lineRef) return "ukjent linje";
  const parts = lineRef.split(":");
  return parts.length >= 3 ? `Linje ${parts[parts.length - 1]}` : lineRef;
}

export function DataQualityBanner({ date, operator = "SKY", lineRef, stopRef, className }: Props) {
  const [expanded, setExpanded] = useState(false);

  const params = new URLSearchParams({ date, operator });
  if (lineRef) params.set("lineRef", lineRef);
  if (stopRef) params.set("stopRef", stopRef);

  const { data: warnings = [] } = useQuery<DataQualityWarning[]>({
    queryKey: ["/api/data-quality", date, operator, lineRef, stopRef],
    queryFn: async () => {
      const res = await fetch(`/api/data-quality?${params}`);
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  if (warnings.length === 0) return null;

  const outliers = warnings.filter((w) => w.type === "outlier_delay");
  const missingTime = warnings.find((w) => w.type === "missing_time");

  const summaryParts: string[] = [];
  if (outliers.length > 0)
    summaryParts.push(
      `${outliers.length} avgang${outliers.length > 1 ? "er" : ""} med usannsynlig forsinkelse`,
    );
  if (missingTime)
    summaryParts.push(`${missingTime.count} registreringer mangler tidsstempeldata`);

  return (
    <div
      className={cn(
        "rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 text-sm",
        className,
      )}
    >
      {/* Summary row */}
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-amber-800 dark:text-amber-300">Datakvalitet: </span>
          <span className="text-amber-700 dark:text-amber-400">{summaryParts.join(" · ")}</span>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 flex-shrink-0 transition-colors"
          aria-label={expanded ? "Skjul detaljer" : "Vis detaljer"}
        >
          {expanded ? (
            <>
              Skjul <ChevronUp className="h-3.5 w-3.5" />
            </>
          ) : (
            <>
              Vis mer <ChevronDown className="h-3.5 w-3.5" />
            </>
          )}
        </button>
      </div>

      {/* Expanded detail rows */}
      {expanded && (
        <div className="border-t border-amber-200 dark:border-amber-900/50 divide-y divide-amber-100 dark:divide-amber-900/30">
          {outliers.map((w) => (
            <div key={w.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
              <TrendingUp className="h-3.5 w-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-0.5">
                <p className="text-amber-800 dark:text-amber-300">{w.message}</p>
                <p className="text-xs text-amber-600/70 dark:text-amber-500/70">
                  {w.aimedTime && <span>Planlagt: kl. {w.aimedTime} · </span>}
                  {w.lineRef && <span>{formatLineRef(w.lineRef)} · </span>}
                  {w.delayMin != null && (
                    <span>
                      Registrert forsinkelse: {w.delayMin > 0 ? "+" : ""}
                      {w.delayMin.toFixed(0)} min
                    </span>
                  )}
                </p>
              </div>
            </div>
          ))}
          {missingTime && (
            <div className="flex items-start gap-2.5 px-3.5 py-2.5">
              <Clock className="h-3.5 w-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-amber-800 dark:text-amber-300">{missingTime.message}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
