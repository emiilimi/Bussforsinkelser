import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useParquetQuery } from "@/hooks/use-parquet-query";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PercentileResult {
  p50: number | null;
  p80: number | null;
  p95: number | null;
  n: number;
}

interface DelayPercentilesProps {
  lineRef: string;
  stopRef?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DelayPercentiles({ lineRef, stopRef }: DelayPercentilesProps) {
  const { loading: parquetLoading, error: parquetError, ready, query } =
    useParquetQuery();

  const {
    data,
    isLoading: queryLoading,
    error: queryError,
  } = useQuery<PercentileResult>({
    queryKey: ["duckdb-percentiles", lineRef, stopRef ?? ""],
    queryFn: async (): Promise<PercentileResult> => {
      const whereClause = stopRef
        ? `WHERE line_ref = '${escapeSql(lineRef)}' AND stop_ref = '${escapeSql(stopRef)}' AND delay_departure_min IS NOT NULL`
        : `WHERE line_ref = '${escapeSql(lineRef)}' AND delay_departure_min IS NOT NULL`;

      const sql = `
        SELECT
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_departure_min) AS p50,
          PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_departure_min) AS p80,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_departure_min) AS p95,
          COUNT(*) AS n
        FROM delays
        ${whereClause}
      `;

      const rows = await query<PercentileResult>(sql);
      if (rows.length === 0) {
        return { p50: null, p80: null, p95: null, n: 0 };
      }
      return rows[0];
    },
    enabled: ready && !parquetLoading && !!lineRef,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // While DuckDB or Parquet files are loading, show skeleton
  if (parquetLoading || queryLoading) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Persentiler (avgang)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-24 mb-2" />
          <Skeleton className="h-4 w-40" />
        </CardContent>
      </Card>
    );
  }

  // Error state
  const errorMsg = parquetError ?? (queryError instanceof Error ? queryError.message : null);
  if (errorMsg) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Persentiler (avgang)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Kunne ikke laste persentildata
          </p>
        </CardContent>
      </Card>
    );
  }

  // No Parquet data available
  if (!ready || !data || data.n === 0) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Persentiler (avgang)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Ingen data tilgjengelig</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Persentiler (avgang)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-4">
          <PercentileStat label="P50" value={data.p50} />
          <PercentileStat label="P80" value={data.p80} />
          <PercentileStat label="P95" value={data.p95} />
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Basert på {data.n.toLocaleString("nb-NO")} observasjoner (DuckDB-WASM)
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function PercentileStat({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  const formatted =
    value != null ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}m` : "--";
  const colorClass =
    value == null
      ? ""
      : value > 10
        ? "text-destructive"
        : value > 5
          ? "text-amber-500"
          : "text-emerald-600";

  return (
    <div className="text-center">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold font-mono ${colorClass}`}>
        {formatted}
      </div>
    </div>
  );
}

/** Simple SQL string escape to prevent injection in DuckDB queries. */
function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
