import type { Express } from "express";
import { createServer, type Server } from "http";
import { subDays, format } from "date-fns";
import {
  getDailySummary,
  getLatestSummary,
  getDailySummaryRange,
  getLinesForDate,
  getLineStats,
  getLineHourlyProfile,
  getAllLines,
  getStopStats,
  getStopHourlyProfile,
  searchStops,
  getStopsForMap,
  getLeaderboardLines,
  getLeaderboardLinesPeriod,
  getLeaderboardStops,
  getWorstDays,
  getBestDays,
  getLatestStopDate,
  getJourneysForLine,
  getJourneyProfile,
  getWorstStopsForLine,
  getLineStopProfile,
  getLinesAtStop,
  getLineHourlyAtStop,
  getDataQuality,
  getStopsForMapFiltered,
  getStopDirections,
  getWorstJourneysForLine,
  getRouteVariants,
} from "./storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function yesterday(): string {
  return format(subDays(new Date(), 1), "yyyy-MM-dd");
}

function daysAgoIso(n: number): string {
  return format(subDays(new Date(), n), "yyyy-MM-dd");
}

function parseDate(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return fallback;
}

function parseOperator(raw: unknown, fallback = "SKY"): string {
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  /**
   * GET /api/summary?date=2025-03-07&operator=SKY
   * Daily overview: avg delay, % on time, % >10 min late, journeys, cancellations.
   */
  app.get("/api/summary", async (req, res) => {
    const date = parseDate(req.query.date, yesterday());
    const operator = parseOperator(req.query.operator);
    const row = await getDailySummary(date, operator);
    if (!row) {
      const latest = await getLatestSummary(operator);
      if (!latest) return res.status(404).json({ message: "Ingen data tilgjengelig" });
      return res.json(latest);
    }
    return res.json(row);
  });

  /**
   * GET /api/summary/trend?days=30&operator=SKY
   * Returns daily summaries for the last N days (for the trend chart).
   */
  app.get("/api/summary/trend", async (req, res) => {
    const days = Math.min(Number(req.query.days) || 7, 365);
    const operator = parseOperator(req.query.operator);
    const rows = await getDailySummaryRange(daysAgoIso(days), yesterday(), operator);
    return res.json(rows);
  });

  /**
   * GET /api/lines?date=2025-03-07&limit=20
   * Line leaderboard for a specific date.
   */
  app.get("/api/lines", async (req, res) => {
    const date = parseDate(req.query.date, yesterday());
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await getLinesForDate(date, limit);
    return res.json(rows);
  });

  /**
   * GET /api/lines/all?operator=SKY
   * Full list of known lines (for dropdowns).
   */
  app.get("/api/lines/all", async (req, res) => {
    const operator = typeof req.query.operator === "string" ? req.query.operator : undefined;
    const rows = await getAllLines(operator);
    return res.json(rows);
  });

  /**
   * GET /api/line/:lineref?days=30&direction=all|0|1
   * Stats for one line: daily trend + hourly profile.
   * direction: 'all' (default) aggregates both, '0' = outbound only, '1' = inbound only.
   */
  app.get("/api/line/:lineref", async (req, res) => {
    const lineRef = req.params.lineref;
    const days = Math.min(Number(req.query.days) || 30, 365);
    const direction = typeof req.query.direction === "string" ? req.query.direction : undefined;
    const [daily, hourly] = await Promise.all([
      getLineStats(lineRef, daysAgoIso(days), direction),
      getLineHourlyProfile(lineRef, direction),
    ]);
    if (daily.length === 0 && hourly.length === 0) {
      return res.status(404).json({ message: "Linje ikke funnet" });
    }
    return res.json({ daily, hourly });
  });

  /**
   * GET /api/line/:lineref/journeys?weeks=4
   * Unique service journeys on a line for the journey picker dropdown.
   * Returns (serviceJourneyId, directionRef, firstStopTime) per journey.
   */
  app.get("/api/line/:lineref/journeys", async (req, res) => {
    const lineRef = req.params.lineref;
    const weeks = Math.min(Number(req.query.weeks) || 4, 13);
    const rows = await getJourneysForLine(lineRef, daysAgoIso(weeks * 7));
    return res.json(rows);
  });

  /**
   * GET /api/line/:lineref/stops?weeks=4
   * Worst stops on a line (aggregated from journey_stop_weekly).
   */
  app.get("/api/line/:lineref/stops", async (req, res) => {
    const lineRef = req.params.lineref;
    const weeks = Math.min(Number(req.query.weeks) || 4, 13);
    const rows = await getWorstStopsForLine(lineRef, daysAgoIso(weeks * 7));
    return res.json(rows);
  });

  /**
   * GET /api/line/:lineref/worst-journeys?direction=1&weeks=13
   * Worst (most delayed) individual scheduled departures for a line.
   * Returns service journeys ranked by weighted avg delay across all stops.
   */
  app.get("/api/line/:lineref/worst-journeys", async (req, res) => {
    const lineRef = req.params.lineref;
    const direction = typeof req.query.direction === "string" ? req.query.direction : "1";
    const weeks = Math.min(Number(req.query.weeks) || 13, 13);
    const rows = await getWorstJourneysForLine(lineRef, direction, daysAgoIso(weeks * 7));
    return res.json(rows);
  });

  /**
   * GET /api/line/:lineref/route-variants?direction=1&weeks=4
   * Distinct route patterns for a line (different start/end/stop counts).
   * Used to populate a variant picker when a line has multiple routes.
   */
  app.get("/api/line/:lineref/route-variants", async (req, res) => {
    const lineRef = req.params.lineref;
    const direction = typeof req.query.direction === "string" ? req.query.direction : "1";
    const weeks = Math.min(Number(req.query.weeks) || 4, 13);
    const rows = await getRouteVariants(lineRef, direction, daysAgoIso(weeks * 7));
    return res.json(rows);
  });

  /**
   * GET /api/line/:lineref/stop-profile?direction=0|1&weeks=4&variant=...
   * All stops on a line in route order with avg/max/min delay.
   * direction defaults to '0'. Route order is direction-specific.
   * Optional variant param filters to a specific route pattern.
   */
  app.get("/api/line/:lineref/stop-profile", async (req, res) => {
    const lineRef = req.params.lineref;
    const direction = typeof req.query.direction === "string" ? req.query.direction : "0";
    const weeks = Math.min(Number(req.query.weeks) || 4, 13);
    const variant = typeof req.query.variant === "string" ? req.query.variant : undefined;
    const rows = await getLineStopProfile(lineRef, direction, daysAgoIso(weeks * 7), variant);
    return res.json(rows);
  });

  /**
   * GET /api/journey?line=SKY:Line:6&dir=0&time=05:48
   * Delay profile at each stop, aggregated across all dated variants of this
   * logical journey (identified by line + direction + first-stop departure time).
   */
  app.get("/api/journey", async (req, res) => {
    const lineRef = typeof req.query.line === "string" ? req.query.line : "";
    const directionRef = typeof req.query.dir === "string" ? req.query.dir : "0";
    const firstStopTime = typeof req.query.time === "string" ? req.query.time : "";
    if (!lineRef || !firstStopTime) {
      return res.status(400).json({ message: "line og time er påkrevd" });
    }
    const rows = await getJourneyProfile(lineRef, directionRef, firstStopTime);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Reise ikke funnet" });
    }
    return res.json(rows);
  });

  /**
   * GET /api/stop/:stopref?days=30&operator=SKY&direction=all|0|1
   * Stats for one stop: daily trend + hourly profile.
   * direction: 'all' (default) aggregates both directions, '0' = outbound, '1' = inbound.
   */
  app.get("/api/stop/:stopref", async (req, res) => {
    const stopRef = req.params.stopref;
    const days = Math.min(Number(req.query.days) || 30, 365);
    const operator = parseOperator(req.query.operator);
    const direction = typeof req.query.direction === "string" ? req.query.direction : undefined;
    const [rows, hourly] = await Promise.all([
      getStopStats(stopRef, daysAgoIso(days), operator, direction),
      getStopHourlyProfile(stopRef, operator, direction).catch(() => []),
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Stoppested ikke funnet" });
    }
    const avgDelay =
      rows.reduce((sum, r) => sum + (r.avgDelayMin ?? 0), 0) / rows.length;
    const totalDepartures = rows.reduce((sum, r) => sum + (r.numDepartures ?? 0), 0);
    const stopName = rows[0].stopName;

    return res.json({
      stopRef,
      stopName,
      avgDelayMin: Math.round(avgDelay * 100) / 100,
      totalDepartures,
      daily: rows,
      hourly,
    });
  });

  /**
   * GET /api/stop/:stopref/directions?operator=SKY
   * Available direction_ref values at a stop.
   */
  app.get("/api/stop/:stopref/directions", async (req, res) => {
    const stopRef = req.params.stopref;
    const operator = parseOperator(req.query.operator);
    const dirs = await getStopDirections(stopRef, operator);
    return res.json(dirs);
  });

  /**
   * GET /api/stop/:stopref/lines?weeks=4
   * Lines serving a stop with their avg delay (last N weeks).
   */
  app.get("/api/stop/:stopref/lines", async (req, res) => {
    const stopRef = req.params.stopref;
    const weeks = Math.min(Number(req.query.weeks) || 4, 13);
    const rows = await getLinesAtStop(stopRef, daysAgoIso(weeks * 7));
    return res.json(rows);
  });

  /**
   * GET /api/stop/:stopref/lines/hourly?weeks=4
   * Hourly delay profile per line at a given stop (from journey_stop_weekly).
   * Returns one row per (lineRef, hour) with weighted average delay.
   */
  app.get("/api/stop/:stopref/lines/hourly", async (req, res) => {
    const stopRef = req.params.stopref;
    const weeks = Math.min(Number(req.query.weeks) || 4, 13);
    const rows = await getLineHourlyAtStop(stopRef, daysAgoIso(weeks * 7));
    return res.json(rows);
  });

  /**
   * GET /api/stops/search?q=festplassen
   * Typeahead stop search.
   */
  app.get("/api/stops/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json([]);
    const rows = await searchStops(q, 20);
    return res.json(rows.map((r) => ({
      stopRef: r.stopRef,
      stopName: r.stopName,
      platformCodes: r.platformCodes,
      // Parse "NSR:Quay:53114|J,NSR:Quay:53115|F" → [{stopRef, platformCode}]
      quays: r.quayData
        ? r.quayData.split(",").map((s) => {
            const idx = s.lastIndexOf("|");
            return { stopRef: s.slice(0, idx), platformCode: s.slice(idx + 1) };
          }).filter((q) => q.platformCode)
        : [],
    })));
  });

  /**
   * GET /api/stops/map?date=2025-03-07&operator=SKY
   * All stops with avg delay on a given date, including lat/lng.
   * Falls back to the latest available date if no data for the requested date.
   */
  app.get("/api/stops/map", async (req, res) => {
    const requestedDate = parseDate(req.query.date, yesterday());
    const operator = parseOperator(req.query.operator);
    const dayType = (req.query.dayType as string) || "all";
    const hourMin = req.query.hourMin != null ? Number(req.query.hourMin) : undefined;
    const hourMax = req.query.hourMax != null ? Number(req.query.hourMax) : undefined;
    const windowDays = Math.min(Number(req.query.windowDays) || 7, 90);

    const hasFilters = dayType !== "all" || hourMin != null || hourMax != null || windowDays !== 7;

    let rows;
    if (hasFilters) {
      rows = await getStopsForMapFiltered(
        requestedDate,
        operator,
        dayType as any,
        hourMin,
        hourMax,
        windowDays,
      );
    } else {
      rows = await getStopsForMap(requestedDate, operator);
      if (rows.length === 0) {
        const latestDate = await getLatestStopDate();
        if (latestDate && latestDate !== requestedDate) {
          rows = await getStopsForMap(latestDate, operator);
        }
      }
    }
    return res.json(rows);
  });

  /**
   * GET /api/leaderboard/lines?type=worst|best&period=alltime|month|week&operator=SKY
   */
  app.get("/api/leaderboard/lines", async (req, res) => {
    const type = req.query.type === "best" ? "best" : "worst";
    const period = req.query.period as string;
    const operator = typeof req.query.operator === "string" ? req.query.operator : undefined;

    let rows;
    if (period === "week") {
      rows = await getLeaderboardLinesPeriod(type, daysAgoIso(7), operator);
    } else if (period === "month") {
      rows = await getLeaderboardLinesPeriod(type, daysAgoIso(30), operator);
    } else {
      rows = await getLeaderboardLines(type, operator);
    }
    return res.json(rows);
  });

  /**
   * GET /api/leaderboard/stops?type=worst|best&days=7&operator=SKY
   * Computed live from stop_daily for the last N days (default 7).
   */
  app.get("/api/leaderboard/stops", async (req, res) => {
    const type = req.query.type === "best" ? "best" : "worst";
    const days = Math.min(Number(req.query.days) || 7, 365);
    const operator = parseOperator(req.query.operator);
    const rows = await getLeaderboardStops(type, daysAgoIso(days), operator);
    return res.json(rows);
  });

  /**
   * GET /api/worst-days?limit=10&operator=SKY
   */
  app.get("/api/worst-days", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const operator = parseOperator(req.query.operator);
    const rows = await getWorstDays(limit, operator);
    return res.json(rows);
  });

  /**
   * GET /api/best-days?limit=10&operator=SKY
   */
  app.get("/api/best-days", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const operator = parseOperator(req.query.operator);
    const rows = await getBestDays(limit, operator);
    return res.json(rows);
  });

  /**
   * GET /api/data-quality?date=2026-03-19&operator=SKY[&lineRef=SKY:Line:6][&stopRef=NSR:Quay:xxx]
   * Returns data quality warnings for a specific date.
   * Optionally filtered by lineRef or stopRef to show only page-relevant warnings.
   */
  app.get("/api/data-quality", async (req, res) => {
    const date = String(req.query.date || yesterday());
    const operator = parseOperator(req.query.operator);
    const lineRef = req.query.lineRef ? String(req.query.lineRef) : undefined;
    const stopRef = req.query.stopRef ? String(req.query.stopRef) : undefined;
    const rows = await getDataQuality(date, operator, lineRef, stopRef);
    return res.json(rows);
  });

  return httpServer;
}
