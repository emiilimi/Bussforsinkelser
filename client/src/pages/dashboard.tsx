import { useQuery, keepPreviousData } from "@tanstack/react-query";
import Layout from "@/components/layout";
import { RegionSelector } from "@/components/region-selector";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Cell, Line, ComposedChart } from "recharts";
import { Clock, TrendingUp, TrendingDown, Bus, CheckCircle, XCircle } from "lucide-react";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useRegion, REGION_LABEL } from "@/lib/RegionContext";
import { DataQualityBanner } from "@/components/data-quality-banner";
import { InfoTip } from "@/components/info-tip";
import { lineNumber, formatDateShortNO, formatWeekdayDateNO, formatWeekNO, formatMonthNO } from "@/lib/date-utils";
import { IS_REISE } from "@/lib/app-mode";
import { BusLoading } from "@/components/bus-loading";
import { useUrlParam } from "@/hooks/use-url-state";

type DailySummary = {
  date: string;
  avgDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  totalJourneys: number | null;
  totalCancellations: number | null;
  // Andel av planlagte stopp-passeringer med sanntid (0–100). Måles ved
  // ingest fra og med juli 2026 — null for eldre dager.
  pctRealtimeCoverage?: number | null;
  // Avganger i feeden helt uten sanntid (ikke avlyst) — null før målingen startet
  journeysMissingRealtime?: number | null;
};

type LeaderboardLine = {
  lineRef: string;
  lineName: string | null;
  avgDelayMin: number | null;
  pctOnTime: number | null;
  pctDelayed10plus: number | null;
  totalDepartures: number | null;
};

// Reise-bygget har 90 dagers datagrunnlag (14 uker parquet) — «År» finnes ikke.
const PERIOD_DAYS: Record<string, number> = IS_REISE
  ? { week: 7, month: 30, year: 90 }
  : { week: 7, month: 30, year: 365 };

/** Display name for bar chart: "60 — Fanahammeren - Lagunen" or just "Linje 60" */
function lineLabel(l: LeaderboardLine): string {
  const num = lineNumber(l.lineRef);
  const name = l.lineName;
  if (name && name !== `Linje ${num}`) return `${num} — ${name}`;
  return `Linje ${num}`;
}

/** Short label for card: "Linje 60" */
function lineShortLabel(l: LeaderboardLine): string {
  return `Linje ${lineNumber(l.lineRef)}`;
}

function formatTrendDate(isoDate: string, period: string): string {
  if (period === "week") return formatWeekdayDateNO(isoDate);
  if (period === "year") return formatDateShortNO(isoDate);
  // month view: "ons 19."
  return formatWeekdayDateNO(isoDate);
}

export default function Dashboard() {
  const [period, setPeriod] = useUrlParam("period", "week");
  const [, navigate] = useLocation();
  const { operators, region } = useRegion();
  const days = PERIOD_DAYS[period];

  // opStr is the raw query param (no leading separator) — appended with ? or & as needed per URL
  const opStr = operators.length ? `operator=${operators.join(",")}` : "";

  const { data: summary, isFetching: summaryFetching } = useQuery<DailySummary>({
    queryKey: [`/api/summary${opStr ? `?${opStr}` : ""}`],
    placeholderData: keepPreviousData,
  });
  const { data: trend = [], isFetching: trendFetching } = useQuery<DailySummary[]>({
    queryKey: [`/api/summary/trend?days=${days}${opStr ? `&${opStr}` : ""}`],
    placeholderData: keepPreviousData,
  });
  const { data: worstLines = [], isFetching: worstLinesFetching } = useQuery<LeaderboardLine[]>({
    queryKey: [`/api/leaderboard/lines?type=worst&period=${period}${opStr ? `&${opStr}` : ""}`],
    placeholderData: keepPreviousData,
  });
  const { data: bestLines = [], isFetching: bestLinesFetching } = useQuery<LeaderboardLine[]>({
    queryKey: [`/api/leaderboard/lines?type=best&period=${period}${opStr ? `&${opStr}` : ""}`],
    placeholderData: keepPreviousData,
  });

  const isRefreshing = summaryFetching || trendFetching || worstLinesFetching || bestLinesFetching;

  // "Snitt forsinkelse" / "Andel i rute" / "Totale avganger" var alltid bundet
  // til `summary` (kun siste dag) selv om Uke/Måned/90 dager-velgeren sitter
  // rett over dem — de endret seg derfor aldri når man byttet periode. Bruker
  // nå et vektet snitt over `trend` (samme data som grafen under) i stedet.
  const periodStats = useMemo(() => {
    let delayNum = 0, delayDen = 0, onTimeNum = 0, onTimeDen = 0;
    let totalJourneys = 0, totalCancellations = 0;
    for (const r of trend) {
      const n = r.totalJourneys ?? 0;
      if (r.avgDelayMin != null) { delayNum += r.avgDelayMin * n; delayDen += n; }
      if (r.pctOnTime != null) { onTimeNum += r.pctOnTime * n; onTimeDen += n; }
      totalJourneys += n;
      totalCancellations += r.totalCancellations ?? 0;
    }
    return {
      avgDelayMin: delayDen > 0 ? delayNum / delayDen : null,
      pctOnTime: onTimeDen > 0 ? onTimeNum / onTimeDen : null,
      totalJourneys,
      totalCancellations,
    };
  }, [trend]);

  const periodLabel = period === "week" ? "Siste uke" : period === "month" ? "Siste måned" : `Siste ${days} dager`;

  const trendData = useMemo(() => {
    const raw = trend.map((r) => ({
      date: r.date,
      label: formatTrendDate(r.date, period),
      avgDelay: r.avgDelayMin ?? 0,
      pctOnTime: r.pctOnTime ?? 0,
      movingAvg: null as number | null,
    }));

    // Add 7-day moving average for month/year view
    if (period !== "week" && raw.length > 7) {
      for (let i = 0; i < raw.length; i++) {
        const start = Math.max(0, i - 6);
        const window = raw.slice(start, i + 1);
        raw[i].movingAvg = +(window.reduce((s, r) => s + r.avgDelay, 0) / window.length).toFixed(2);
      }
    }

    return raw;
  }, [trend, period]);

  const topWorst = worstLines.slice(0, 5).map(l => ({
    ...l,
    label: lineLabel(l),
  }));
  const topBest = bestLines.slice(0, 5).map(l => ({
    ...l,
    label: lineLabel(l),
  }));

  return (
    <Layout>
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Oversikt — {REGION_LABEL[region]}</h2>
            <p className="text-muted-foreground mt-1">
              Forsinkelsesstatistikk for siste {days} dager
              {summary?.date && <span className="text-xs ml-2 opacity-70">· Sist oppdatert: {formatDateShortNO(summary.date)}</span>}
              {summary?.pctRealtimeCoverage != null && (
                <span
                  className="text-xs ml-2 opacity-70"
                  title="Andel av ikke-avlyste stopp-passeringer i sanntids-feeden som rapporterte tid siste dag. Avlysninger telles separat."
                >
                  · Sanntidsdekning: {summary.pctRealtimeCoverage.toFixed(1)} %
                </span>
              )}
              {summary?.journeysMissingRealtime != null && (
                <span
                  className="text-xs ml-2 opacity-70"
                  title="Avganger i feeden som ikke rapporterte sanntid på noe stopp (avlyste holdt utenfor)"
                >
                  · {summary.journeysMissingRealtime.toLocaleString("nb-NO")} avganger uten sanntid
                </span>
              )}
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <RegionSelector />
            <Tabs value={period} onValueChange={setPeriod} className="w-[300px]">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="week">Uke</TabsTrigger>
                <TabsTrigger value="month">Måned</TabsTrigger>
                <TabsTrigger value="year">{IS_REISE ? "90 dager" : "År"}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {isRefreshing && (
          <div className="flex items-center">
            <BusLoading label="Laster nye data" scale={0.4} />
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="border-l-4 border-l-primary shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                Snitt forsinkelse
                <InfoTip learnMoreHref="/metode#hva-vises">
                  Gjennomsnittlig differanse (i minutter) mellom faktisk og planlagt avgangstid, vektet over valgt periode.
                </InfoTip>
              </CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                {periodStats.avgDelayMin != null ? `${periodStats.avgDelayMin.toFixed(1)}m` : "—"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{periodLabel}</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-emerald-500 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                Andel i rute
                <InfoTip learnMoreHref="/metode#punktlighet">
                  Andel stopp-passeringer med høyst 2 minutter forsinkelse, vektet over valgt periode. Punktlighetsdefinisjonen varierer mellom operatører — vi bruker en relativt streng grense.
                </InfoTip>
              </CardTitle>
              <CheckCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                {periodStats.pctOnTime != null ? `${periodStats.pctOnTime.toFixed(1)}%` : "—"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Høyst 2 min forsinkelse · {periodLabel.toLowerCase()}</p>
            </CardContent>
          </Card>

          <Card
            className={`border-l-4 border-l-orange-500 shadow-sm hover:shadow-md transition-shadow ${worstLines[0] ? "cursor-pointer" : ""}`}
            onClick={() => worstLines[0] && navigate(`/journey?line=${encodeURIComponent(worstLines[0].lineRef)}`)}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Dårligste linje</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold truncate">
                {worstLines[0] ? lineShortLabel(worstLines[0]) : "—"}
              </div>
              <p className="text-xs text-destructive mt-1">
                {worstLines[0]?.avgDelayMin != null
                  ? `+${worstLines[0].avgDelayMin.toFixed(1)}m snitt`
                  : ""}
              </p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-primary/50 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Totale avganger</CardTitle>
              <Bus className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">
                {periodStats.totalJourneys > 0
                  ? periodStats.totalJourneys.toLocaleString("nb-NO")
                  : "—"}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {periodLabel}
                {periodStats.totalCancellations > 0 && (
                  <span className="text-destructive ml-1">
                    <XCircle className="h-3 w-3 inline mr-0.5" />
                    {periodStats.totalCancellations} kansellert
                  </span>
                )}
              </p>
            </CardContent>
          </Card>
        </div>

        {summary?.date && (
          <DataQualityBanner date={summary.date} operator={operators[0]} />
        )}

        {/* Trend chart */}
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Forsinkelse over tid</CardTitle>
            <CardDescription>
              Gjennomsnittlig forsinkelse per dag
              {period !== "week" && " · glidende 7-dagers snitt vist som linje"}
            </CardDescription>
          </CardHeader>
          <CardContent className="pl-2">
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trendData}>
                  <defs>
                    <linearGradient id="colorDelay" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--destructive))" stopOpacity={0.1} />
                      <stop offset="95%" stopColor="hsl(var(--destructive))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="label"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    interval={period === "year" ? Math.floor(trendData.length / 12) : undefined}
                  />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                    labelFormatter={(_, payload) => {
                      const d = payload?.[0]?.payload?.date;
                      if (!d) return "";
                      const weekInfo = period !== "week" ? ` (${formatWeekNO(d)})` : "";
                      return `${formatDateShortNO(d)}${weekInfo}`;
                    }}
                    formatter={(v: number, name: string) => [
                      `${v.toFixed(2)} min`,
                      name === "movingAvg" ? "7-dagers snitt" : "Daglig forsinkelse",
                    ]}
                  />
                  <Area type="monotone" dataKey="avgDelay" stroke="hsl(var(--destructive))" strokeWidth={1.5} fillOpacity={1} fill="url(#colorDelay)" name="avgDelay" />
                  {period !== "week" && (
                    <Line type="monotone" dataKey="movingAvg" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} name="movingAvg" />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Worst + Best lines side by side */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-destructive" />
                <div>
                  <CardTitle>Dårligste linjer</CardTitle>
                  <CardDescription>Høyest gjennomsnittlig forsinkelse. Klikk en linje for detaljer.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {topWorst.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">Ingen data</p>
              ) : (
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart layout="vertical" data={topWorst} margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                      <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                      <YAxis dataKey="label" type="category" stroke="hsl(var(--muted-foreground))" fontSize={11} width={160} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                        formatter={(v: number) => [`${v.toFixed(2)} min`, "Snitt forsinkelse"]}
                      />
                      <Bar
                        dataKey="avgDelayMin"
                        radius={[0, 4, 4, 0]}
                        barSize={24}
                        cursor="pointer"
                        onClick={(data: any) => data?.lineRef && navigate(`/journey?line=${encodeURIComponent(data.lineRef)}`)}
                      >
                        {topWorst.map((entry, index) => (
                          <Cell
                            key={index}
                            fill={
                              (entry.avgDelayMin ?? 0) > 5
                                ? "hsl(var(--destructive))"
                                : (entry.avgDelayMin ?? 0) > 2
                                ? "hsl(var(--chart-4))"
                                : "hsl(var(--chart-2))"
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2">
                <TrendingDown className="h-5 w-5 text-emerald-500" />
                <div>
                  <CardTitle>Beste linjer</CardTitle>
                  <CardDescription>Lavest gjennomsnittlig forsinkelse. Klikk en linje for detaljer.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {topBest.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">Ingen data</p>
              ) : (
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart layout="vertical" data={topBest} margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                      <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(v) => `${v.toFixed(1)}m`} />
                      <YAxis dataKey="label" type="category" stroke="hsl(var(--muted-foreground))" fontSize={11} width={160} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                        formatter={(v: number) => [`${v.toFixed(2)} min`, "Snitt forsinkelse"]}
                      />
                      <Bar
                        dataKey="avgDelayMin"
                        radius={[0, 4, 4, 0]}
                        barSize={24}
                        cursor="pointer"
                        onClick={(data: any) => data?.lineRef && navigate(`/journey?line=${encodeURIComponent(data.lineRef)}`)}
                      >
                        {topBest.map((_, index) => (
                          <Cell key={index} fill="hsl(var(--chart-2))" />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
