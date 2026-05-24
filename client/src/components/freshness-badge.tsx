import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { formatDateNO } from "@/lib/date-utils";

interface HealthResponse {
  status: "ok" | "stale" | "no_data" | "error";
  lastIngestDate: string | null;
  staleDays: number | null;
}

/**
 * Liten indikator i sidebar som viser dato for siste data-oppdatering.
 * Stale > 2 dager vises som oransje varsel; ellers subtil grå tekst.
 * Pollet hver time (staleTime).
 */
export function FreshnessBadge() {
  const { data } = useQuery<HealthResponse>({
    queryKey: ["/api/health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error("health unreachable");
      return res.json();
    },
    staleTime: 60 * 60 * 1000, // 1 time
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!data || !data.lastIngestDate) return null;

  const dateLabel = formatDateNO(data.lastIngestDate);

  if (data.status === "stale") {
    return (
      <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-[10px] text-amber-900">
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px text-amber-600" />
        <span>
          <span className="font-semibold">Data ikke oppdatert siden {dateLabel}.</span>{" "}
          Nye tall kommer normalt hver natt.
        </span>
      </div>
    );
  }

  return (
    <div className="text-[10px] text-muted-foreground px-3">
      Sist oppdatert: <span className="font-medium text-foreground/80">{dateLabel}</span>
    </div>
  );
}
