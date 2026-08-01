import type { Express } from "express";
import { createServer, type Server } from "http";
import { subDays, format } from "date-fns";
import path from "path";
import fs from "fs";
import express from "express";
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
  getStopsByRefs,
  getStopsByRefsExpanded,
  getStopsForMap,
  getLeaderboardLines,
  getLeaderboardLinesPeriod,
  getLeaderboardStops,
  getWorstDays,
  getBestDays,
  getLatestStopDate,
  getDataQuality,
  getStopsForMapFiltered,
  getStopDirections,
  getLeaderboardLinesByReliability,
  searchStopsForCorridor,
  parseDayTypes,
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
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const upper = raw.toUpperCase();
  return VALID_OPERATORS.has(upper) ? upper : fallback;
}

/**
 * Whitelist av kjente operatørkoder. Matcher `_ALL_OPERATORS` i
 * pipeline/ingest.py. Defense-in-depth mot at uventede strenger havner
 * i SQL eller upstream-kall, selv om alle queries bruker parameterbinding.
 */
const VALID_OPERATORS = new Set([
  "SKY", "MOR", "INN", "OST", "RUT", "KOL", "VYG", "TRO", "BRA", "FIN",
  "NOR", "AKT", "ATB", "BNR", "NBU", "FLI", "FLT", "GOA", "VOT",
]);

/**
 * Parses ?operator=SKY,RUT,MOR → ["SKY","RUT","MOR"]
 * Empty string or missing → [] (means "all operators, no filter").
 * Ukjente koder filtreres bort.
 */
function parseOperators(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && VALID_OPERATORS.has(s));
}

/** Parse ?mode=bus|tram|metro|water|all (default "all"). */
function parseMode(raw: unknown): string {
  return typeof raw === "string" && raw.length > 0 ? raw.toLowerCase() : "all";
}

/**
 * Parse a numeric query parameter safely.
 * - undefined/empty/non-string → fallback
 * - non-numeric string → fallback (Number("abc") = NaN, which is filtered)
 * - "0" still returns 0 (unlike `Number(x) || fallback`).
 * Caller can clamp/validate further.
 */
function parseIntQuery(raw: unknown, fallback: number): number {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parses ?days=N or ?from=YYYY-MM-DD&to=YYYY-MM-DD into a normalized window.
 * Returns { fromIso, toIso, days } where `days` is the number of calendar days
 * in the window (used for `journey_stop_weekly` queries which need `weeks`).
 *
 * Defaults: `days=defaultDays` (caller-supplied), capped at maxDays.
 */
function parseTimeWindow(
  query: any,
  defaultDays = 30,
  maxDays = 365,
): { fromIso: string; toIso: string; days: number } {
  const isDate = (s: unknown): s is string =>
    typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (isDate(query.from) && isDate(query.to)) {
    const a = query.from <= query.to ? query.from : query.to;
    const b = query.from <= query.to ? query.to : query.from;
    const days = Math.min(
      maxDays,
      Math.max(
        1,
        Math.ceil((Date.parse(b) - Date.parse(a)) / 86400000) + 1,
      ),
    );
    return { fromIso: a, toIso: b, days };
  }
  const days = Math.min(maxDays, Math.max(1, Number(query.days) || defaultDays));
  return { fromIso: daysAgoIso(days), toIso: yesterday(), days };
}

/**
 * journey_stop_weekly only retains 13 weeks. This helper accepts either
 * `?weeks=N` (legacy) or the same `?days/from/to` shape as parseTimeWindow,
 * and returns the `fromIso` cutoff to use in the WHERE clause.
 */
function parseWeeksWindow(query: any, defaultWeeks = 13): string {
  const isDate = (s: unknown): s is string =>
    typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const maxWeeks = 13;
  if (isDate(query.from)) {
    return query.from;
  }
  if (typeof query.days === "string" || typeof query.days === "number") {
    const days = Math.min(maxWeeks * 7, Math.max(1, Number(query.days) || defaultWeeks * 7));
    return daysAgoIso(days);
  }
  const weeks = Math.min(maxWeeks, Math.max(1, Number(query.weeks) || defaultWeeks));
  return daysAgoIso(weeks * 7);
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per-IP sliding window)
// ---------------------------------------------------------------------------

/**
 * Tiny in-memory rate limiter. Protects upstream Entur API (~30 req/min limit
 * unregistered) and our own DB from bursts. Keys per IP; sliding window via
 * timestamp list. Process-local — if you run multiple replicas, replace with
 * a shared store. For a single Railway instance this is sufficient.
 */
function makeRateLimiter(opts: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, number[]>();

  return function rateLimit(
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ) {
    // Prefer X-Forwarded-For first entry when behind Railway/proxy; else req.ip.
    const xff = req.headers["x-forwarded-for"];
    const ip =
      (typeof xff === "string" ? xff.split(",")[0]!.trim() : undefined) ||
      req.ip ||
      "unknown";

    const now = Date.now();
    const cutoff = now - opts.windowMs;
    const list = (hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (list.length >= opts.max) {
      const retryAfter = Math.ceil((list[0]! + opts.windowMs - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfter)));
      return res.status(429).json({
        error: "For mange forespørsler — prøv igjen om litt.",
      });
    }
    list.push(now);
    hits.set(ip, list);

    // Occasional cleanup of stale keys (every ~500 requests).
    // Array.from: tsconfig-target under es2015 kan ikke iterere Map direkte.
    if (hits.size > 500 && Math.random() < 0.01) {
      for (const [key, arr] of Array.from(hits.entries())) {
        if (arr.every((t) => t <= cutoff)) hits.delete(key);
      }
    }
    next();
  };
}

const tripLimiter = makeRateLimiter({ windowMs: 60_000, max: 20, name: "trip" });
const geocoderLimiter = makeRateLimiter({ windowMs: 60_000, max: 60, name: "geocoder" });
const departuresLimiter = makeRateLimiter({ windowMs: 60_000, max: 30, name: "departures" });

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // -----------------------------------------------------------------------
  // GET /api/health
  // Returns server liveness + data freshness. Used by frontend
  // freshness-badge and external uptime probes.
  // -----------------------------------------------------------------------
  app.get("/api/health", async (_req, res) => {
    try {
      const lastDate = await getLatestStopDate();
      if (!lastDate) {
        return res.json({ status: "no_data", lastIngestDate: null, staleDays: null });
      }
      const today = new Date();
      const last = new Date(lastDate + "T00:00:00Z");
      const staleDays = Math.floor(
        (today.getTime() - last.getTime()) / 86_400_000,
      );
      const status = staleDays > 2 ? "stale" : "ok";
      return res.json({ status, lastIngestDate: lastDate, staleDays });
    } catch {
      return res.status(500).json({ status: "error" });
    }
  });
  /**
   * GET /api/summary?date=2025-03-07&operator=SKY
   * Daily overview: avg delay, % on time, % >10 min late, journeys, cancellations.
   */
  app.get("/api/summary", async (req, res) => {
    const date = parseDate(req.query.date, yesterday());
    const operators = parseOperators(req.query.operator);
    const row = await getDailySummary(date, operators);
    if (!row) {
      const latest = await getLatestSummary(operators);
      if (!latest) return res.status(404).json({ message: "Ingen data tilgjengelig" });
      return res.json(latest);
    }
    return res.json(row);
  });

  /**
   * GET /api/summary/trend?days=30&operator=SKY,RUT
   * Returns daily summaries for the last N days (for the trend chart).
   */
  app.get("/api/summary/trend", async (req, res) => {
    const { fromIso, toIso } = parseTimeWindow(req.query, 7);
    const operators = parseOperators(req.query.operator);
    const rows = await getDailySummaryRange(fromIso, toIso, operators);
    return res.json(rows);
  });

  /**
   * GET /api/lines?date=2025-03-07&limit=20
   * Line leaderboard for a specific date.
   */
  app.get("/api/lines", async (req, res) => {
    const date = parseDate(req.query.date, yesterday());
    const limit = Math.min(Math.max(1, parseIntQuery(req.query.limit, 20)), 100);
    const rows = await getLinesForDate(date, limit);
    return res.json(rows);
  });

  /**
   * GET /api/lines/all?operator=SKY,RUT
   * Full list of known lines (for dropdowns). Empty/missing operator = all regions.
   */
  app.get("/api/lines/all", async (req, res) => {
    const operators = parseOperators(req.query.operator);
    const rows = await getAllLines(operators);
    return res.json(rows);
  });

  /**
   * GET /api/line/:lineref?days=30&direction=all|0|1
   * Stats for one line: daily trend + hourly profile.
   * direction: 'all' (default) aggregates both, '0' = outbound only, '1' = inbound only.
   */
  app.get("/api/line/:lineref", async (req, res) => {
    const lineRef = req.params.lineref;
    const { fromIso, toIso } = parseTimeWindow(req.query, 30);
    const direction = typeof req.query.direction === "string" ? req.query.direction : undefined;
    const dayTypes = parseDayTypes(req.query.dayType as string | undefined);
    const [daily, hourly] = await Promise.all([
      getLineStats(lineRef, fromIso, direction, toIso),
      getLineHourlyProfile(lineRef, direction, dayTypes),
    ]);
    if (daily.length === 0 && hourly.length === 0) {
      return res.status(404).json({ message: "Linje ikke funnet" });
    }
    return res.json({ daily, hourly });
  });

  // NOTE: /api/line/:lineref/journeys, /stops, /worst-journeys, /best-journeys,
  // /route-variants, /stop-profile, and /api/journey have been removed.
  // These queries now run client-side via DuckDB-WASM against Parquet on R2.
  // See client/src/hooks/use-journey-queries.ts

  /**
   * GET /api/stop/:stopref?days=30&operator=SKY&direction=all|0|1
   * Stats for one stop: daily trend + hourly profile.
   * direction: 'all' (default) aggregates both directions, '0' = outbound, '1' = inbound.
   */
  app.get("/api/stop/:stopref", async (req, res) => {
    const stopRef = req.params.stopref;
    const { fromIso, toIso } = parseTimeWindow(req.query, 30);
    const operators = parseOperators(req.query.operator);
    const direction = typeof req.query.direction === "string" ? req.query.direction : undefined;
    const dayTypes = parseDayTypes(req.query.dayType as string | undefined);
    const [rows, hourly] = await Promise.all([
      getStopStats(stopRef, fromIso, operators, direction, toIso),
      getStopHourlyProfile(stopRef, operators, direction, dayTypes).catch(() => []),
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
    const operators = parseOperators(req.query.operator);
    const dirs = await getStopDirections(stopRef, operators);
    return res.json(dirs);
  });

  /**
  // NOTE: /api/stop/:stopref/lines and /api/stop/:stopref/lines/hourly removed.
  // These queries now run client-side via DuckDB-WASM. See use-journey-queries.ts

  /**
   * GET /api/stops/lookup?refs=NSR:Quay:1,NSR:Quay:2,...
   * Batch oppslag: stop_ref → stop_name + stop_place_ref. Brukes av klient-side
   * DuckDB-WASM-hooks for å berike resultater med stoppnavn etter en Parquet-query.
   *
   * Med ?expand=stopplace utvides NSR:StopPlace:X-refs til alle barne-quays
   * (rader hvor stop_place_ref = X). Quay-refs slippes uendret gjennom.
   */
  app.get("/api/stops/lookup", async (req, res) => {
    const refs = String(req.query.refs ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (refs.length === 0) return res.json([]);
    if (refs.length > 500) {
      return res.status(400).json({ error: "Max 500 refs per request" });
    }
    const expand = req.query.expand === "stopplace";
    const rows = expand
      ? await getStopsByRefsExpanded(refs)
      : await getStopsByRefs(refs);
    return res.json(rows);
  });

  /**
   * GET /api/stops/search?q=festplassen
   * Typeahead stop search.
   */
  app.get("/api/stops/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 100);
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
    const operators = parseOperators(req.query.operator);
    const dayType = (req.query.dayType as string) || "all";
    const hmRaw = parseIntQuery(req.query.hourMin, NaN);
    const hMaxRaw = parseIntQuery(req.query.hourMax, NaN);
    const hourMin = Number.isFinite(hmRaw) ? hmRaw : undefined;
    const hourMax = Number.isFinite(hMaxRaw) ? hMaxRaw : undefined;
    const windowDays = Math.min(Math.max(1, parseIntQuery(req.query.windowDays, 7)), 90);

    const hasFilters = dayType !== "all" || hourMin != null || hourMax != null || windowDays !== 7;

    let rows;
    if (hasFilters) {
      rows = await getStopsForMapFiltered(
        requestedDate,
        operators,
        dayType as any,
        hourMin,
        hourMax,
        windowDays,
      );
    } else {
      rows = await getStopsForMap(requestedDate, operators);
      if (rows.length === 0) {
        const latestDate = await getLatestStopDate();
        if (latestDate && latestDate !== requestedDate) {
          rows = await getStopsForMap(latestDate, operators);
        }
      }
    }
    return res.json(rows);
  });

  /**
   * GET /api/leaderboard/lines?type=worst|best&period=alltime|month|week&operator=SKY
   */
  app.get("/api/leaderboard/lines", async (req, res) => {
    const rawType = req.query.type as string | undefined;
    const period = req.query.period as string;
    const operators = parseOperators(req.query.operator);
    const mode = parseMode(req.query.mode);

    // Reliability leaderboards (sort by stddev) — separate from delay-based leaderboards.
    if (rawType === "reliable" || rawType === "unreliable") {
      const rows = await getLeaderboardLinesByReliability(rawType, operators, 10, mode);
      return res.json(rows);
    }

    const type = rawType === "best" ? "best" : "worst";
    let rows;
    if (period === "week") {
      rows = await getLeaderboardLinesPeriod(type, daysAgoIso(7), operators, 10, mode);
    } else if (period === "month") {
      rows = await getLeaderboardLinesPeriod(type, daysAgoIso(30), operators, 10, mode);
    } else {
      rows = await getLeaderboardLines(type, operators, 10, mode);
    }
    return res.json(rows);
  });

  /**
   * GET /api/leaderboard/stops?type=worst|best&days=7&operator=SKY,RUT&mode=bus
   * Computed live from stop_daily for the last N days (default 7).
   */
  app.get("/api/leaderboard/stops", async (req, res) => {
    const type = req.query.type === "best" ? "best" : "worst";
    const { fromIso, toIso } = parseTimeWindow(req.query, 7);
    const operators = parseOperators(req.query.operator);
    const mode = parseMode(req.query.mode);
    const rows = await getLeaderboardStops(type, fromIso, operators, 10, toIso, mode);
    return res.json(rows);
  });

  /**
   * GET /api/worst-days?limit=10&operator=SKY,RUT
   */
  app.get("/api/worst-days", async (req, res) => {
    const limit = Math.min(Math.max(1, parseIntQuery(req.query.limit, 10)), 100);
    const operators = parseOperators(req.query.operator);
    // Only pass from/to when explicitly provided to keep materialized-table fast path.
    const hasWindow =
      typeof req.query.from === "string" ||
      typeof req.query.to === "string" ||
      typeof req.query.days === "string";
    const window = hasWindow ? parseTimeWindow(req.query, 30) : undefined;
    const dayTypes = parseDayTypes(req.query.dayType as string | undefined);
    const rows = await getWorstDays(limit, operators, window?.fromIso, window?.toIso, dayTypes);
    return res.json(rows);
  });

  /**
   * GET /api/best-days?limit=10&operator=SKY,RUT
   */
  app.get("/api/best-days", async (req, res) => {
    const limit = Math.min(Math.max(1, parseIntQuery(req.query.limit, 10)), 100);
    const operators = parseOperators(req.query.operator);
    const hasWindow =
      typeof req.query.from === "string" ||
      typeof req.query.to === "string" ||
      typeof req.query.days === "string";
    const window = hasWindow ? parseTimeWindow(req.query, 30) : undefined;
    const dayTypes = parseDayTypes(req.query.dayType as string | undefined);
    const rows = await getBestDays(limit, operators, window?.fromIso, window?.toIso, dayTypes);
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

  // NOTE: POST /api/corridor removed. Now client-side DuckDB. See use-journey-queries.ts

  /**
   * GET /api/stops/corridor-search?q=birkelund
   * Search stops for the corridor picker (lightweight, no join with stop_daily).
   */
  app.get("/api/stops/corridor-search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json([]);
    const rows = await searchStopsForCorridor(q);
    return res.json(rows);
  });

  /**
   * GET /api/geocoder/autocomplete?text=Bryggen+Bergen&size=8
   * Proxy to Entur Geocoder — returns stops AND addresses.
   */
  app.get("/api/geocoder/autocomplete", geocoderLimiter, async (req, res) => {
    const text = String(req.query.text || "").trim().slice(0, 200);
    if (text.length < 2) return res.json([]);
    const size = Math.min(Math.max(1, parseIntQuery(req.query.size, 8)), 20);
    try {
      const url = `https://api.entur.io/geocoder/v1/autocomplete?text=${encodeURIComponent(text)}&size=${size}&lang=no`;
      const response = await fetch(url, {
        headers: { "ET-Client-Name": "emiliemoldestad-sentur" },
      });
      if (!response.ok) {
        return res.status(502).json({ error: "Geocoder error" });
      }
      const data: any = await response.json();
      const results = (data.features || []).map((f: any) => ({
        id: f.properties.id,
        name: f.properties.name,
        label: f.properties.label,
        layer: f.properties.layer, // "venue" = stop, "address" = address, "street", etc.
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
      }));
      return res.json(results);
    } catch {
      return res.status(502).json({ error: "Geocoder unreachable" });
    }
  });

  /**
   * GET /api/geocoder/reverse?lat=60.39&lng=5.32
   * Reverse-geocoder proxy — finner nærmeste sted/adresse for et koordinatpar.
   * Brukes av "Min posisjon" for å vise hvor posisjonen faktisk ble tolket.
   */
  app.get("/api/geocoder/reverse", geocoderLimiter, async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "lat/lng required" });
    }
    try {
      const url = `https://api.entur.io/geocoder/v1/reverse?point.lat=${lat}&point.lon=${lng}&size=1&lang=no`;
      const response = await fetch(url, {
        headers: { "ET-Client-Name": "emiliemoldestad-sentur" },
      });
      if (!response.ok) {
        return res.status(502).json({ error: "Geocoder error" });
      }
      const data: any = await response.json();
      const f = (data.features || [])[0];
      const result = f
        ? {
            id: f.properties.id,
            name: f.properties.name,
            label: f.properties.label,
            layer: f.properties.layer,
            lat: f.geometry.coordinates[1],
            lng: f.geometry.coordinates[0],
          }
        : null;
      return res.json(result);
    } catch {
      return res.status(502).json({ error: "Geocoder unreachable" });
    }
  });

  // -----------------------------------------------------------------------
  // Trip planner — Entur Journey Planner API v3 proxy (/reise)
  // -----------------------------------------------------------------------

  // Simple in-memory cache for Entur trip queries.
  // Key: "from|to|5-min-bucket"  →  { data, expiry }
  // Avoids hammering the Entur API (~30 req/min limit for unregistered consumers).
  const TRIP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const TRIP_CACHE_MAX = 200;               // max entries before oldest evicted
  const tripCache = new Map<string, { data: any; expiry: number }>();

  function tripCacheKey(from: string, to: string, dateTime: string): string {
    // Bucket by 5-minute window so near-identical queries share cache
    const d = new Date(dateTime);
    const bucket = Math.floor(d.getTime() / (5 * 60_000));
    return `${from}|${to}|${bucket}`;
  }

  function tripCacheGet(key: string): any | null {
    const entry = tripCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      tripCache.delete(key);
      return null;
    }
    return entry.data;
  }

  function tripCacheSet(key: string, data: any): void {
    // Evict oldest entries if cache is full
    if (tripCache.size >= TRIP_CACHE_MAX) {
      const oldest = tripCache.keys().next().value;
      if (oldest) tripCache.delete(oldest);
    }
    tripCache.set(key, { data, expiry: Date.now() + TRIP_CACHE_TTL_MS });
  }

  /**
   * POST /api/trip
   * Body: {
   *   from: "NSR:StopPlace:X",
   *   to: "NSR:StopPlace:Y",
   *   when?: ISO datetime,
   *   arriveBy?: boolean,           // true = "arrive by" instead of "depart at"
   *   transportModes?: string[],    // ["bus","tram","metro","rail","water","coach"]
   *   accessMode?: string,          // "foot" | "scooter_rental" | "bicycle" | "bike_rental" | "car_park"
   *   egressMode?: string,          // same options
   *   directMode?: string | null,   // null to disable walking-only results
   *   walkSpeed?: number,           // m/s (default ~1.33 = 4.8 km/h)
   *   transferSlack?: number,       // extra seconds at each transfer (default 120)
   *   maximumTransfers?: number,    // max transfers (default unlimited)
   *   numTripPatterns?: number,     // results to return (default 5, max 10)
   *   wheelchairAccessible?: boolean,
   *   searchWindow?: number,        // seconds to search (widens time range)
   * }
   *
   * Proxies to Entur Journey Planner v3 GraphQL API.
   * Results cached 5 min per (from, to, time-bucket).
   */
  app.post("/api/trip", tripLimiter, async (req, res) => {
    const {
      from, to, when,
      arriveBy,
      transportModes,
      accessMode,
      egressMode,
      directMode,
      walkSpeed,
      transferSlack,
      maximumTransfers,
      numTripPatterns,
      wheelchairAccessible,
      searchWindow,
      pageCursor,
    } = req.body ?? {};

    if (!from || !to) {
      return res.status(400).json({ error: "from and to required (Location object or NSR:StopPlace string)" });
    }

    // from/to can be: string (legacy, NSR:StopPlace) or { place: "..." } or { coordinates: {latitude, longitude}, name: "..." }
    const fromLocation = typeof from === "string" ? { place: from } : from;
    const toLocation = typeof to === "string" ? { place: to } : to;

    const dateTime = when || new Date().toISOString();
    // pageCursor: ugjennomsiktig Entur-token for tidligere/senere-paginering.
    // Konservativt tegnsett så den ikke kan injiseres som GraphQL.
    const safePageCursor =
      typeof pageCursor === "string" && /^[A-Za-z0-9+/=_-]{1,512}$/.test(pageCursor)
        ? pageCursor
        : null;
    // Cache key includes all parameters that affect the query result.
    // Normalize undefined → null so JSON.stringify produces stable, distinguishable
    // keys (without normalization, `{ dm: undefined }` serializes to `{}`, colliding
    // with calls that intentionally omit directMode).
    const filterFingerprint = JSON.stringify({
      f: fromLocation, t: toLocation,
      m: transportModes ?? null,
      ab: arriveBy ?? null,
      ws: walkSpeed ?? null,
      ts: transferSlack ?? null,
      mt: maximumTransfers ?? null,
      wc: wheelchairAccessible ?? null,
      sw: searchWindow ?? null,
      np: numTripPatterns ?? null,
      am: accessMode ?? null,
      em: egressMode ?? null,
      dm: directMode ?? null,
      pc: safePageCursor,
    });
    const cacheKey = tripCacheKey(
      JSON.stringify(fromLocation), JSON.stringify(toLocation), dateTime
    ) + "|" + filterFingerprint;

    // Check cache first
    const cached = tripCacheGet(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Build transport modes array — default: all common transit modes.
    // Whitelist-valider — verdiene interpoleres direkte i GraphQL-dokumentet.
    const VALID_TRANSPORT_MODES = new Set([
      "bus", "tram", "rail", "metro", "water", "coach",
      "air", "cableway", "funicular", "lift", "trolleybus", "monorail",
    ]);
    const safeModes = Array.isArray(transportModes)
      ? transportModes.filter((m: unknown): m is string => typeof m === "string" && VALID_TRANSPORT_MODES.has(m))
      : [];
    const modes = safeModes.length > 0
      ? safeModes
      : ["bus", "tram", "rail", "metro", "water", "coach"];
    const transportModesGql = modes.map((m: string) => `{ transportMode: ${m} }`).join(", ");

    // Build modes block — accessMode/egressMode default to "foot" (required for coordinate-based locations).
    // Whitelist-valider — interpoleres direkte i GraphQL-dokumentet.
    const VALID_STREET_MODES = new Set([
      "foot", "bicycle", "bike_park", "bike_rental", "scooter_rental",
      "car", "car_park", "car_pickup", "car_rental", "carpool", "flexible",
    ]);
    const safeStreet = (v: unknown, fallback: string | null): string | null =>
      typeof v === "string" && VALID_STREET_MODES.has(v) ? v : fallback;
    const accessModeGql = `accessMode: ${safeStreet(accessMode, "foot")}`;
    const egressModeGql = `egressMode: ${safeStreet(egressMode, "foot")}`;
    const safeDirect = safeStreet(directMode, null);
    const directModeGql = safeDirect ? `directMode: ${safeDirect}` : "";
    const modesBlock = [
      `transportModes: [${transportModesGql}]`,
      accessModeGql,
      egressModeGql,
      directModeGql,
    ].filter(Boolean).join(", ");

    // Build optional parameters
    const optionals: string[] = [];
    if (arriveBy === true) optionals.push("arriveBy: true");
    if (typeof walkSpeed === "number") optionals.push(`walkSpeed: ${walkSpeed}`);
    if (typeof transferSlack === "number") optionals.push(`transferSlack: ${transferSlack}`);
    if (typeof maximumTransfers === "number") optionals.push(`maximumTransfers: ${maximumTransfers}`);
    if (wheelchairAccessible === true) optionals.push("wheelchairAccessible: true");
    if (typeof searchWindow === "number") optionals.push(`searchWindow: ${searchWindow}`);
    const numPatterns = Math.min(Number(numTripPatterns) || 5, 12);
    optionals.push(`numTripPatterns: ${numPatterns}`);
    if (safePageCursor) optionals.push("pageCursor: $pageCursor");

    const cursorDecl = safePageCursor ? ", $pageCursor: String" : "";
    const query = `
      query trip($from: Location!, $to: Location!, $dateTime: DateTime!${cursorDecl}) {
        trip(
          from: $from
          to: $to
          dateTime: $dateTime
          modes: { ${modesBlock} }
          ${optionals.join("\n          ")}
        ) {
          nextPageCursor
          previousPageCursor
          tripPatterns {
            expectedStartTime
            expectedEndTime
            duration
            legs {
              mode
              transportSubmode
              fromPlace {
                name
                quay { id name publicCode latitude longitude }
              }
              toPlace {
                name
                quay { id name publicCode latitude longitude }
              }
              line {
                id
                publicCode
                name
              }
              expectedStartTime
              expectedEndTime
              duration
              distance
              pointsOnLink { points }
              intermediateQuays {
                id
                name
                publicCode
                latitude
                longitude
              }
              serviceJourney {
                id
                passingTimes {
                  quay { id }
                  departure { time dayOffset }
                  arrival { time dayOffset }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const variables: Record<string, unknown> = {
        from: fromLocation,
        to: toLocation,
        dateTime,
      };
      if (safePageCursor) variables.pageCursor = safePageCursor;
      console.log("[trip] Query:", JSON.stringify({ from: fromLocation, to: toLocation, dateTime, modes: modes.join(","), optionals }));

      const response = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ET-Client-Name": "emiliemoldestad-sentur",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error("[trip] Entur HTTP error:", response.status, text.slice(0, 500));
        return res.status(502).json({ error: "Reisetjenesten er ikke tilgjengelig akkurat nå." });
      }

      const data = await response.json();
      if (data.errors) {
        console.error("[trip] GraphQL errors:", JSON.stringify(data.errors).slice(0, 500));
      }
      const patternCount = data?.data?.trip?.tripPatterns?.length ?? 0;
      console.log("[trip] Result: %d patterns", patternCount);

      tripCacheSet(cacheKey, data);
      return res.json(data);
    } catch (err: any) {
      console.error("[trip] Entur unreachable:", err?.message);
      return res.status(502).json({ error: "Reisetjenesten er ikke tilgjengelig akkurat nå." });
    }
  });

  // -----------------------------------------------------------------------
  // /api/departures — stopPlace estimatedCalls proxy (Sanntid-aktig visning)
  // -----------------------------------------------------------------------

  const DEP_CACHE_TTL_MS = 60 * 1000;  // 1 minute (mer aggressiv enn trip pga sanntid)
  const DEP_CACHE_MAX = 200;
  const depCache = new Map<string, { data: any; expiry: number }>();

  /**
   * GET /api/departures/:stopPlaceRef?minutes=90&limit=50
   * Returnerer kommende avganger fra et stoppested via Entur stopPlace-query.
   *
   * stopPlaceRef: NSR:StopPlace:X
   * minutes: tidsvindu i minutter (15–360, default 90)
   * limit: maks antall avganger (5–100, default 50)
   *
   * Cachet 60 sek server-side. Klienten kan refresh med `refetchInterval`.
   */
  app.get("/api/departures/:stopPlaceRef", departuresLimiter, async (req, res) => {
    // Express 5 typer params som string | string[] — én navngitt segment er
    // alltid string i praksis.
    const stopPlaceRef = String(req.params.stopPlaceRef);
    if (!/^NSR:(StopPlace|Quay):\d+$/.test(stopPlaceRef)) {
      return res.status(400).json({ error: "Invalid stopPlaceRef" });
    }
    const minutes = Math.min(Math.max(parseIntQuery(req.query.minutes, 90), 15), 360);
    const limit = Math.min(Math.max(parseIntQuery(req.query.limit, 50), 5), 100);
    // startTime: ISO-datetime for avganger rundt et annet tidspunkt enn nå
    const startTimeRaw = typeof req.query.startTime === "string" ? req.query.startTime : null;
    const startTime =
      startTimeRaw && !Number.isNaN(Date.parse(startTimeRaw))
        ? new Date(startTimeRaw).toISOString()
        : null;
    // view=arrivals inkluderer avganger som KUN ankommer (endeholdeplass).
    // Whitelist — interpoleres i GraphQL-dokumentet.
    const viewRaw = typeof req.query.view === "string" ? req.query.view : null;
    const view = viewRaw === "arrivals" || viewRaw === "both" ? viewRaw : "departures";

    const bucket = Math.floor(Date.now() / DEP_CACHE_TTL_MS);
    const cacheKey = `${stopPlaceRef}|${minutes}|${limit}|${startTime ?? ""}|${view}|${bucket}`;
    const cached = depCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return res.json(cached.data);
    }

    const isQuay = stopPlaceRef.startsWith("NSR:Quay:");
    const rootSelector = isQuay ? "quay" : "stopPlace";
    const startDecl = startTime ? ", $start: DateTime!" : "";
    const startArg = startTime ? "startTime: $start, " : "";
    const query = `
      query StopDepartures($id: String!, $range: Int!, $n: Int!${startDecl}) {
        ${rootSelector}(id: $id) {
          id
          name
          estimatedCalls(${startArg}arrivalDeparture: ${view}, timeRange: $range, numberOfDepartures: $n) {
            aimedDepartureTime
            expectedDepartureTime
            aimedArrivalTime
            expectedArrivalTime
            realtime
            cancellation
            destinationDisplay { frontText }
            quay { id name publicCode }
            serviceJourney {
              id
              directionType
              line { id publicCode name transportMode }
            }
          }
        }
      }`;

    try {
      const response = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ET-Client-Name": "emiliemoldestad-sentur",
        },
        body: JSON.stringify({
          query,
          variables: {
            id: stopPlaceRef,
            range: minutes * 60,
            n: limit,
            ...(startTime ? { start: startTime } : {}),
          },
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        console.error("[departures] Entur HTTP error:", response.status, text.slice(0, 300));
        return res.status(502).json({ error: "Avgangstjenesten er ikke tilgjengelig akkurat nå." });
      }
      const data = await response.json();
      if (data.errors) {
        console.error("[departures] GraphQL errors:", JSON.stringify(data.errors).slice(0, 500));
      }
      const place = data?.data?.[rootSelector];
      if (!place) {
        return res.json({ stopName: null, departures: [] });
      }

      const calls = (place.estimatedCalls ?? []) as Array<any>;
      const departures = calls.map((c) => ({
        aimedTime: c.aimedDepartureTime,
        expectedTime: c.expectedDepartureTime,
        aimedArrivalTime: c.aimedArrivalTime ?? null,
        expectedArrivalTime: c.expectedArrivalTime ?? null,
        realtime: !!c.realtime,
        cancelled: !!c.cancellation,
        destination: c.destinationDisplay?.frontText ?? null,
        quayRef: c.quay?.id ?? null,
        quayName: c.quay?.name ?? null,
        platform: c.quay?.publicCode ?? null,
        lineRef: c.serviceJourney?.line?.id ?? null,
        lineNumber: c.serviceJourney?.line?.publicCode ?? null,
        lineName: c.serviceJourney?.line?.name ?? null,
        transportMode: c.serviceJourney?.line?.transportMode ?? null,
        serviceJourneyId: c.serviceJourney?.id ?? null,
        directionRef: c.serviceJourney?.directionType ?? null,
      }));

      const result = { stopName: place.name, stopRef: place.id, departures };

      // LRU evict
      if (depCache.size >= DEP_CACHE_MAX) {
        const oldest = depCache.keys().next().value;
        if (oldest) depCache.delete(oldest);
      }
      depCache.set(cacheKey, { data: result, expiry: Date.now() + DEP_CACHE_TTL_MS });
      return res.json(result);
    } catch (err: any) {
      console.error("[departures] Entur unreachable:", err?.message);
      return res.status(502).json({ error: "Avgangstjenesten er ikke tilgjengelig akkurat nå." });
    }
  });

  /**
   * GET /api/servicejourney/:id?date=YYYY-MM-DD
   * Full stoppliste for én avgang med planlagte tider + sanntid per stopp.
   * Speiler functions/api/servicejourney/[id].ts (Cloudflare-versjonen).
   */
  app.get("/api/servicejourney/:id", departuresLimiter, async (req, res) => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9:_\-.]{1,128}$/.test(id)) {
      return res.status(400).json({ error: "Invalid serviceJourneyId" });
    }
    const dateRaw = typeof req.query.date === "string" ? req.query.date : null;
    const date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
      ? dateRaw
      : new Date().toISOString().slice(0, 10);

    const bucket = Math.floor(Date.now() / DEP_CACHE_TTL_MS);
    const cacheKey = `sj|${id}|${date}|${bucket}`;
    const cached = depCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return res.json(cached.data);
    }

    const query = `
      query SJ($id: String!, $date: Date!) {
        serviceJourney(id: $id) {
          id
          line { id publicCode name transportMode }
          estimatedCalls(date: $date) {
            quay { id name publicCode }
            aimedArrivalTime
            expectedArrivalTime
            aimedDepartureTime
            expectedDepartureTime
            realtime
            cancellation
            destinationDisplay { frontText }
          }
        }
      }`;

    try {
      const response = await fetch("https://api.entur.io/journey-planner/v3/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ET-Client-Name": "emiliemoldestad-sentur",
        },
        body: JSON.stringify({ query, variables: { id, date } }),
      });
      if (!response.ok) {
        const text = await response.text();
        console.error("[servicejourney] Entur HTTP error:", response.status, text.slice(0, 300));
        return res.status(502).json({ error: "Tjenesten er ikke tilgjengelig akkurat nå." });
      }
      const data = await response.json();
      if (data.errors) {
        console.error("[servicejourney] GraphQL errors:", JSON.stringify(data.errors).slice(0, 500));
      }
      const sj = data?.data?.serviceJourney;
      if (!sj) {
        return res.json({ serviceJourneyId: id, line: null, calls: [] });
      }

      const calls = (sj.estimatedCalls ?? []).map((c: any) => ({
        quayRef: c.quay?.id ?? null,
        quayName: c.quay?.name ?? null,
        platform: c.quay?.publicCode ?? null,
        aimedArrival: c.aimedArrivalTime ?? null,
        expectedArrival: c.expectedArrivalTime ?? null,
        aimedDeparture: c.aimedDepartureTime ?? null,
        expectedDeparture: c.expectedDepartureTime ?? null,
        realtime: !!c.realtime,
        cancelled: !!c.cancellation,
        destination: c.destinationDisplay?.frontText ?? null,
      }));

      const result = {
        serviceJourneyId: sj.id,
        line: sj.line
          ? {
              lineRef: sj.line.id,
              publicCode: sj.line.publicCode,
              name: sj.line.name,
              transportMode: sj.line.transportMode,
            }
          : null,
        date,
        calls,
      };

      if (depCache.size >= DEP_CACHE_MAX) {
        const oldest = depCache.keys().next().value;
        if (oldest) depCache.delete(oldest);
      }
      depCache.set(cacheKey, { data: result, expiry: Date.now() + DEP_CACHE_TTL_MS });
      return res.json(result);
    } catch (err: any) {
      console.error("[servicejourney] Entur unreachable:", err?.message);
      return res.status(502).json({ error: "Tjenesten er ikke tilgjengelig akkurat nå." });
    }
  });

  // -----------------------------------------------------------------------
  // Parquet files for DuckDB-WASM (client-side percentile queries)
  // -----------------------------------------------------------------------

  const parquetDir = path.resolve(
    process.env.PARQUET_DIR || path.join("data", "parquet"),
  );

  /**
   * GET /api/parquet/manifest
   * Returns JSON array of available Parquet week filenames (e.g. ["2026-W14.parquet", "2026-W15.parquet"]).
   */
  app.get("/api/parquet/manifest", (_req, res) => {
    try {
      if (!fs.existsSync(parquetDir)) {
        return res.json([]);
      }
      const files = fs
        .readdirSync(parquetDir)
        .filter((f) => f.endsWith(".parquet"))
        .sort();
      return res.json(files);
    } catch {
      return res.json([]);
    }
  });

  /**
   * Static serving of data/parquet/ at /api/parquet/
   * Allows DuckDB-WASM to fetch Parquet files via HTTP range requests.
   */
  app.use(
    "/api/parquet",
    express.static(parquetDir, {
      setHeaders(res) {
        // Allow range requests for DuckDB-WASM HTTP filesystem
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", "application/octet-stream");
      },
    }),
  );

  // NOTE: POST /api/trip/stats removed. Now client-side DuckDB. See trip-planner.tsx

  return httpServer;
}
