import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { desc, eq, gte, lte, and, like, sql, notInArray, inArray } from "drizzle-orm";
import { resolve } from "path";
import * as schema from "@shared/schema";

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

const DB_PATH = resolve(
  process.env.DATABASE_PATH ?? "./data/bussforsinkelser.db",
);

const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

// All vehicle modes included in aggregations. 'coach' (flybuss) is kept
// distinct from 'bus' so the trip planner can filter the two separately.
// 'ferry' is the actual vehicleMode value Skyss SIRI ET uses for boat routes
// (not 'water', which is the NeTEx/Entur transport mode name).
export const INCLUDED_MODES = ["bus", "coach", "tram", "metro", "rail", "water", "ferry"] as const;
export type VehicleMode = (typeof INCLUDED_MODES)[number];

// Day-type filter values used by the backend. 'all' (or undefined) = no filter.
export const DAY_TYPES = ["weekday", "saturday", "sunday", "holiday", "may17"] as const;
export type DayType = (typeof DAY_TYPES)[number];

/** Parse a comma-separated `?modes=` query into a validated whitelist subset. */
export function parseModes(input: string | string[] | undefined): VehicleMode[] {
  if (!input) return [...INCLUDED_MODES];
  const raw = Array.isArray(input) ? input.join(",") : input;
  if (raw === "all") return [...INCLUDED_MODES];
  const requested = raw.split(",").map((s) => s.trim().toLowerCase());
  const filtered = requested.filter((m): m is VehicleMode =>
    (INCLUDED_MODES as readonly string[]).includes(m),
  );
  return filtered.length ? filtered : [...INCLUDED_MODES];
}

/** SQL fragment listing all included vehicle modes, e.g. `'bus','coach',...`. Use as `vehicle_mode IN (${INCLUDED_MODES_SQL})`. */
export const INCLUDED_MODES_SQL = INCLUDED_MODES.map((m) => `'${m}'`).join(",");

/** Parse a comma-separated `?dayType=` query. Returns null when no filter applies. */
export function parseDayTypes(input: string | string[] | undefined): DayType[] | null {
  if (!input) return null;
  const raw = Array.isArray(input) ? input.join(",") : input;
  if (raw === "all") return null;
  const requested = raw.split(",").map((s) => s.trim().toLowerCase());
  const filtered = requested.filter((d): d is DayType =>
    (DAY_TYPES as readonly string[]).includes(d),
  );
  return filtered.length ? filtered : null;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function getDailySummary(date: string, operator = "SKY") {
  return db
    .select()
    .from(schema.dailySummary)
    .where(
      and(
        eq(schema.dailySummary.date, date),
        eq(schema.dailySummary.operator, operator),
      ),
    )
    .get();
}

export async function getLatestSummary(operator = "SKY") {
  return db
    .select()
    .from(schema.dailySummary)
    .where(eq(schema.dailySummary.operator, operator))
    .orderBy(desc(schema.dailySummary.date))
    .limit(1)
    .get();
}

export async function getDailySummaryRange(fromDate: string, toDate: string, operator = "SKY") {
  return db
    .select()
    .from(schema.dailySummary)
    .where(
      and(
        gte(schema.dailySummary.date, fromDate),
        lte(schema.dailySummary.date, toDate),
        eq(schema.dailySummary.operator, operator),
      ),
    )
    .orderBy(schema.dailySummary.date)
    .all();
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export async function getLinesForDate(date: string, limit = 20) {
  // Aggregate across both directions to get one row per line (bus only)
  const avgExpr = sql<number>`ROUND(SUM(${schema.lineDaily.avgDelayMin} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 2)`;
  return db
    .select({
      date: schema.lineDaily.date,
      lineRef: schema.lineDaily.lineRef,
      lineName: schema.lineDaily.lineName,
      avgDelayMin: avgExpr,
      numDepartures: sql<number>`SUM(${schema.lineDaily.numDepartures})`,
    })
    .from(schema.lineDaily)
    .where(and(eq(schema.lineDaily.date, date), inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[])))
    .groupBy(schema.lineDaily.lineRef, schema.lineDaily.lineName)
    .orderBy(desc(avgExpr))
    .limit(limit)
    .all();
}

export async function getLineStats(lineRef: string, fromDate: string, direction?: string, toDate?: string) {
  // One aggregated row per date. When direction is a specific value (not 'all' or undefined),
  // filter to that direction only. When 'all' or undefined, aggregate all directions.
  const baseConditions = and(
    eq(schema.lineDaily.lineRef, lineRef),
    gte(schema.lineDaily.date, fromDate),
    toDate ? lte(schema.lineDaily.date, toDate) : undefined,
    inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[]),
    direction && direction !== "all"
      ? eq(schema.lineDaily.directionRef, direction)
      : undefined,
  );
  return db
    .select({
      date: schema.lineDaily.date,
      lineRef: schema.lineDaily.lineRef,
      lineName: schema.lineDaily.lineName,
      avgDelayMin: sql<number>`ROUND(SUM(${schema.lineDaily.avgDelayMin} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 2)`,
      maxDelayMin: sql<number>`ROUND(MAX(${schema.lineDaily.maxDelayMin}), 2)`,
      minDelayMin: sql<number>`ROUND(MIN(${schema.lineDaily.minDelayMin}), 2)`,
      pctOnTime: sql<number>`ROUND(SUM(${schema.lineDaily.pctOnTime} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 1)`,
      pctDelayed10plus: sql<number>`ROUND(SUM(${schema.lineDaily.pctDelayed10plus} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 1)`,
      numDepartures: sql<number>`SUM(${schema.lineDaily.numDepartures})`,
      pctRealtimeCoverage: sql<number | null>`ROUND(SUM(CASE WHEN ${schema.lineDaily.pctRealtimeCoverage} IS NOT NULL THEN ${schema.lineDaily.pctRealtimeCoverage} * ${schema.lineDaily.numDepartures} ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN ${schema.lineDaily.pctRealtimeCoverage} IS NOT NULL THEN ${schema.lineDaily.numDepartures} ELSE 0 END), 0), 1)`,
      stddevDelayMin: sql<number | null>`ROUND(SUM(CASE WHEN ${schema.lineDaily.stddevDelayMin} IS NOT NULL THEN ${schema.lineDaily.stddevDelayMin} * ${schema.lineDaily.numDepartures} ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN ${schema.lineDaily.stddevDelayMin} IS NOT NULL THEN ${schema.lineDaily.numDepartures} ELSE 0 END), 0), 2)`,
    })
    .from(schema.lineDaily)
    .where(baseConditions)
    .groupBy(schema.lineDaily.date)
    .orderBy(schema.lineDaily.date)
    .all();
}

export async function getLineHourlyProfile(lineRef: string, direction?: string, dayTypes?: DayType[] | null) {
  // When direction is a specific value (not 'all' or undefined): return that direction's profile.
  // When 'all' or undefined: aggregate all directions (weighted avg + max/min over all).
  // dayTypes filters across the day_type column (added April 2026). null/undefined = all day types.
  const dtFilter = dayTypes && dayTypes.length
    ? `AND day_type IN (${dayTypes.map((d) => `'${d}'`).join(",")})`
    : "";
  if (direction && direction !== "all") {
    return sqlite.prepare(`
      SELECT
        line_ref       AS lineRef,
        line_name      AS lineName,
        direction_ref  AS directionRef,
        hour,
        ROUND(SUM(avg_delay_min * num_samples) * 1.0 / NULLIF(SUM(num_samples), 0), 2) AS avgDelayMin,
        ROUND(MAX(max_avg_delay_min), 2) AS maxAvgDelayMin,
        ROUND(MIN(min_avg_delay_min), 2) AS minAvgDelayMin,
        SUM(num_samples) AS numSamples
      FROM line_hourly_profile
      WHERE line_ref = ? AND direction_ref = ?
      ${dtFilter}
      GROUP BY hour
      ORDER BY hour
    `).all(lineRef, direction);
  }
  // Aggregate across both directions
  return sqlite.prepare(`
    SELECT
      line_ref       AS lineRef,
      line_name      AS lineName,
      hour,
      ROUND(SUM(avg_delay_min * num_samples) * 1.0 / NULLIF(SUM(num_samples), 0), 2) AS avgDelayMin,
      ROUND(MAX(max_avg_delay_min), 2) AS maxAvgDelayMin,
      ROUND(MIN(min_avg_delay_min), 2) AS minAvgDelayMin,
      SUM(num_samples) AS numSamples
    FROM line_hourly_profile
    WHERE line_ref = ?
    ${dtFilter}
    GROUP BY hour
    ORDER BY hour
  `).all(lineRef);
}

// Bybanen (tram/light rail) — no SIRI ET realtime data available
const EXCLUDED_LINE_REFS = ["SKY:Line:1", "SKY:Line:2"];

export async function getAllLines(operator?: string) {
  // NOTE: We intentionally do NOT filter by operator prefix here.
  // All lines in line_daily were ingested from Skyss's SIRI ET feed (dataSource='SKY'),
  // but some have non-SKY lineRef prefixes (e.g. SOF:Line:901, FIR:Line:123 for Sogn og
  // Fjordane / Firda Billag routes operated under Skyss's contract). Filtering to SKY:%
  // would hide these lines from the picker.
  return db
    .selectDistinct({
      lineRef: schema.lineDaily.lineRef,
      lineName: schema.lineDaily.lineName,
    })
    .from(schema.lineDaily)
    .where(
      and(
        inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[]),
        notInArray(schema.lineDaily.lineRef, EXCLUDED_LINE_REFS),
      ),
    )
    .orderBy(schema.lineDaily.lineName)
    .all();
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

export async function getStopDirections(stopRef: string, operator = "SKY"): Promise<string[]> {
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `stop_ref = ?`;

  const rows = sqlite.prepare(`
    SELECT DISTINCT direction_ref AS dir
    FROM stop_daily
    WHERE ${stopFilter} AND operator = ? AND direction_ref IS NOT NULL
    ORDER BY direction_ref
  `).all(stopRef, operator) as Array<{ dir: string }>;
  return rows.map(r => r.dir);
}

export async function getStopStats(stopRef: string, fromDate: string, operator = "SKY", direction?: string, toDate?: string) {
  // stopRef can be either NSR:Quay:XXXXX (single quay) or NSR:StopPlace:XXXXX
  // (parent stop place, which groups multiple quays together in search results).
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `sd.stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `sd.stop_ref = ?`;
  const toClause = toDate ? `AND sd.date <= ?` : "";

  // 'all': aggregate across directions (and across quays if stop place)
  if (!direction || direction === "all") {
    const params = [stopRef, stopRef, fromDate, ...(toDate ? [toDate] : []), operator];
    return sqlite.prepare(`
      SELECT
        sd.date,
        ? AS stopRef,
        COALESCE(MAX(sc.stop_place_name), MAX(sc.stop_name), MAX(sd.stop_name)) AS stopName,
        ROUND(SUM(sd.avg_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS avgDelayMin,
        ROUND(MAX(sd.max_delay_min), 2) AS maxDelayMin,
        ROUND(MIN(sd.min_delay_min), 2) AS minDelayMin,
        ROUND(SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 1) AS pctDelayed2plus,
        ROUND(SUM(sd.stddev_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS stddevDelayMin,
        SUM(sd.num_departures) AS numDepartures
      FROM stop_daily sd
      LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
      WHERE ${stopFilter} AND sd.date >= ? ${toClause} AND sd.vehicle_mode IN (${INCLUDED_MODES_SQL}) AND sd.operator = ?
      GROUP BY sd.date
      ORDER BY sd.date
    `).all(...params) as any[];
  }

  // Direction-specific: aggregate quays if stop place, keep direction filter
  const params = [stopRef, stopRef, fromDate, ...(toDate ? [toDate] : []), operator, direction];
  return sqlite.prepare(`
    SELECT
      sd.date,
      ? AS stopRef,
      COALESCE(MAX(sc.stop_place_name), MAX(sc.stop_name), MAX(sd.stop_name)) AS stopName,
      ROUND(SUM(sd.avg_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS avgDelayMin,
      ROUND(MAX(sd.max_delay_min), 2) AS maxDelayMin,
      ROUND(MIN(sd.min_delay_min), 2) AS minDelayMin,
      ROUND(SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 1) AS pctDelayed2plus,
      ROUND(SUM(sd.stddev_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS stddevDelayMin,
      SUM(sd.num_departures) AS numDepartures
    FROM stop_daily sd
    LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
    WHERE ${stopFilter} AND sd.date >= ? ${toClause} AND sd.vehicle_mode IN (${INCLUDED_MODES_SQL}) AND sd.operator = ? AND sd.direction_ref = ?
    GROUP BY sd.date
    ORDER BY sd.date
  `).all(...params) as any[];
}

export async function getStopHourlyProfile(stopRef: string, operator = "SKY", direction?: string, dayTypes?: DayType[] | null) {
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `stop_ref = ?`;
  const dtFilter = dayTypes && dayTypes.length
    ? `AND day_type IN (${dayTypes.map((d) => `'${d}'`).join(",")})`
    : "";

  if (!direction || direction === "all") {
    return sqlite.prepare(`
      SELECT
        hour,
        ROUND(SUM(avg_delay_min * num_samples) * 1.0 / NULLIF(SUM(num_samples), 0), 2) AS avgDelayMin,
        ROUND(MAX(max_avg_delay_min), 2) AS maxAvgDelayMin,
        ROUND(MIN(min_avg_delay_min), 2) AS minAvgDelayMin,
        SUM(num_samples) AS numSamples
      FROM stop_hourly_profile
      WHERE ${stopFilter} AND operator = ?
      ${dtFilter}
      GROUP BY hour
      ORDER BY hour
    `).all(stopRef, operator);
  }

  return sqlite.prepare(`
    SELECT
      hour,
      ROUND(SUM(avg_delay_min * num_samples) * 1.0 / NULLIF(SUM(num_samples), 0), 2) AS avgDelayMin,
      ROUND(MAX(max_avg_delay_min), 2) AS maxAvgDelayMin,
      ROUND(MIN(min_avg_delay_min), 2) AS minAvgDelayMin,
      SUM(num_samples) AS numSamples
    FROM stop_hourly_profile
    WHERE ${stopFilter} AND operator = ? AND direction_ref = ?
    ${dtFilter}
    GROUP BY hour
    ORDER BY hour
  `).all(stopRef, operator, direction);
}

/** Batch lookup: gitt en liste stop_refs, returner navn + StopPlace-info.
 *  Brukes av klient-side DuckDB-WASM-hooks for å berike resultater med stoppnavn
 *  uten å måtte shippe stop_coords til klienten via Parquet.
 */
export async function getStopsByRefs(refs: string[]): Promise<Array<{
  stopRef: string;
  stopName: string | null;
  stopPlaceRef: string | null;
  stopPlaceName: string | null;
  lat: number | null;
  lng: number | null;
}>> {
  if (refs.length === 0) return [];
  const ph = refs.map(() => "?").join(",");
  return sqlite
    .prepare(
      `SELECT stop_ref AS stopRef,
              stop_name AS stopName,
              stop_place_ref AS stopPlaceRef,
              stop_place_name AS stopPlaceName,
              lat, lng
         FROM stop_coords
        WHERE stop_ref IN (${ph})`,
    )
    .all(...refs) as any;
}

export async function searchStops(query: string, limit = 20) {
  // Group quays by their parent stop place so "Olav Kyrres gate" appears once
  // with platform letters aggregated (e.g. "E, F, G, H, J") instead of 5× separately.
  // For quays without a stop_place_ref mapping we fall back to the quay itself.
  // quayData: "NSR:Quay:53114|J,NSR:Quay:53115|F,..." for individual platform picker.
  // Uses DISTINCT subquery on stop_daily to avoid duplicating quays across dates.
  return sqlite
    .prepare(
      `
      SELECT
        COALESCE(sc.stop_place_ref, sc.stop_ref)             AS stopRef,
        COALESCE(sc.stop_place_name, MAX(sc.stop_name))      AS stopName,
        GROUP_CONCAT(
          DISTINCT sc.platform_code
          ORDER BY sc.platform_code
        )                                                      AS platformCodes,
        GROUP_CONCAT(
          DISTINCT sc.stop_ref || '|' || sc.platform_code
          ORDER BY sc.platform_code
        )                                                      AS quayData
      FROM stop_coords sc
      INNER JOIN (SELECT DISTINCT stop_ref FROM stop_daily) sd
        ON sd.stop_ref = sc.stop_ref
      WHERE sc.stop_name LIKE ?
         OR sc.stop_place_name LIKE ?
      GROUP BY COALESCE(sc.stop_place_ref, sc.stop_ref)
      ORDER BY stopName
      LIMIT ?
      `,
    )
    .all(`%${query}%`, `%${query}%`, limit) as Array<{
      stopRef: string;
      stopName: string | null;
      platformCodes: string | null;
      quayData: string | null;
    }>;
}

export async function getStopsForMap(date: string, operator = "SKY") {
  // Aggregate over a rolling 7-day window ending on `date`
  return sqlite.prepare(`
    SELECT
      sd.stop_ref                                                     AS stopRef,
      COALESCE(MAX(sc.stop_name), MAX(sd.stop_name))                 AS stopName,
      ROUND(
        SUM(sd.avg_delay_min * sd.num_departures) * 1.0
        / NULLIF(SUM(sd.num_departures), 0), 2)                      AS avgDelayMin,
      ROUND(
        SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0
        / NULLIF(SUM(sd.num_departures), 0), 1)                      AS pctDelayed2plus,
      SUM(sd.num_departures)                                         AS numDepartures,
      MAX(sc.lat)                                                    AS lat,
      MAX(sc.lng)                                                    AS lng
    FROM stop_daily sd
    LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
    WHERE sd.date > date(?, '-7 days')
      AND sd.date <= ?
      AND sd.vehicle_mode IN (${INCLUDED_MODES_SQL})
      AND sd.operator = ?
    GROUP BY sd.stop_ref
    HAVING SUM(sd.num_departures) > 0
  `).all(date, date, operator);
}

/**
 * Map data with optional time-of-day and weekday/weekend filters.
 * Uses stop_hourly_raw when hour filters are specified, otherwise stop_daily.
 * dayType: "all" | "weekday" | "weekend"
 * hourMin/hourMax: hour range (inclusive start, exclusive end), e.g. 7,9 for 07:00-08:59
 */
export async function getStopsForMapFiltered(
  date: string,
  operator = "SKY",
  dayType: "all" | "weekday" | "weekend" = "all",
  hourMin?: number,
  hourMax?: number,
  windowDays = 7,
) {
  const dayFilter =
    dayType === "weekday"
      ? `AND CAST(strftime('%w', t.date) AS INT) BETWEEN 1 AND 5`
      : dayType === "weekend"
      ? `AND CAST(strftime('%w', t.date) AS INT) IN (0, 6)`
      : "";

  if (hourMin != null && hourMax != null) {
    // Use stop_hourly_raw for hour filtering
    const hourFilter =
      hourMin <= hourMax
        ? `AND t.hour >= ${Math.floor(hourMin)} AND t.hour < ${Math.floor(hourMax)}`
        : `AND (t.hour >= ${Math.floor(hourMin)} OR t.hour < ${Math.floor(hourMax)})`; // wraps midnight
    return sqlite.prepare(`
      SELECT
        t.stop_ref                                                    AS stopRef,
        COALESCE(MAX(sc.stop_name), MAX(t.stop_ref))                 AS stopName,
        ROUND(
          SUM(t.avg_delay_min * t.num_samples) * 1.0
          / NULLIF(SUM(t.num_samples), 0), 2)                        AS avgDelayMin,
        SUM(t.num_samples)                                            AS numDepartures,
        MAX(sc.lat)                                                   AS lat,
        MAX(sc.lng)                                                   AS lng
      FROM stop_hourly_raw t
      LEFT JOIN stop_coords sc ON sc.stop_ref = t.stop_ref
      WHERE t.date > date(?, '-${windowDays} days')
        AND t.date <= ?
        AND t.operator = ?
        ${dayFilter}
        ${hourFilter}
      GROUP BY t.stop_ref
      HAVING SUM(t.num_samples) > 0
    `).all(date, date, operator);
  }

  // No hour filter — use stop_daily (has pct_delayed_2plus)
  const dayFilterDaily = dayFilter.replace(/t\./g, "sd.");
  return sqlite.prepare(`
    SELECT
      sd.stop_ref                                                     AS stopRef,
      COALESCE(MAX(sc.stop_name), MAX(sd.stop_name))                 AS stopName,
      ROUND(
        SUM(sd.avg_delay_min * sd.num_departures) * 1.0
        / NULLIF(SUM(sd.num_departures), 0), 2)                      AS avgDelayMin,
      ROUND(
        SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0
        / NULLIF(SUM(sd.num_departures), 0), 1)                      AS pctDelayed2plus,
      SUM(sd.num_departures)                                          AS numDepartures,
      MAX(sc.lat)                                                     AS lat,
      MAX(sc.lng)                                                     AS lng
    FROM stop_daily sd
    LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
    WHERE sd.date > date(?, '-${windowDays} days')
      AND sd.date <= ?
      AND sd.vehicle_mode IN (${INCLUDED_MODES_SQL})
      AND sd.operator = ?
      ${dayFilterDaily}
    GROUP BY sd.stop_ref
    HAVING SUM(sd.num_departures) > 0
  `).all(date, date, operator);
}

export async function getLatestStopDate(): Promise<string | null> {
  const row = db
    .select({ date: schema.stopDaily.date })
    .from(schema.stopDaily)
    .orderBy(desc(schema.stopDaily.date))
    .limit(1)
    .get();
  return row?.date ?? null;
}

// ---------------------------------------------------------------------------
// Journey Stop Weekly — unlocks journey profile, worst stop on line, lines per stop
// ---------------------------------------------------------------------------

/** Unique journeys on a line for the journey picker dropdown.
 *
 *  serviceJourneyId in Entur SIRI ET is a *dated* journey ID (one per day),
 *  not a stable per-schedule ID. The same "05:48 outbound" run gets a new ID
 *  each day. We therefore group by (directionRef, firstStopTime) to collapse
 *  all dated variants into one logical journey entry per departure time.
 *
 *  Returns one row per unique (directionRef, firstStopTime) combination.
 *  numVariants tells you how many dated service journey IDs share that slot.
 */
export async function getJourneysForLine(
  lineRef: string,
  fromWeek: string,
): Promise<Array<{ directionRef: string; firstStopTime: string; numVariants: number; firstStopName: string | null; lastStopName: string | null }>> {
  return sqlite
    .prepare(
      `SELECT
         direction_ref   AS directionRef,
         first_stop_time AS firstStopTime,
         COUNT(*)        AS numVariants,
         MAX(first_stop_name) AS firstStopName,
         MAX(last_stop_name)  AS lastStopName
       FROM (
         SELECT
           jsd.service_journey_id,
           jsd.direction_ref,
           MIN(COALESCE(jsd.aimed_departure, jsd.aimed_arrival)) AS first_stop_time,
           (SELECT COALESCE(sc1.stop_name, jsd1.stop_ref)
            FROM journey_stop_daily jsd1
            LEFT JOIN stop_coords sc1 ON sc1.stop_ref = jsd1.stop_ref
            WHERE jsd1.service_journey_id = jsd.service_journey_id
            ORDER BY jsd1.stop_sequence ASC LIMIT 1) AS first_stop_name,
           (SELECT COALESCE(sc2.stop_name, jsd2.stop_ref)
            FROM journey_stop_daily jsd2
            LEFT JOIN stop_coords sc2 ON sc2.stop_ref = jsd2.stop_ref
            WHERE jsd2.service_journey_id = jsd.service_journey_id
            ORDER BY jsd2.stop_sequence DESC LIMIT 1) AS last_stop_name
         FROM journey_stop_daily jsd
         WHERE jsd.line_ref = ? AND jsd.date >= ?
         GROUP BY jsd.service_journey_id, jsd.direction_ref
       )
       GROUP BY direction_ref, first_stop_time
       ORDER BY direction_ref, first_stop_time`,
    )
    .all(lineRef, fromWeek) as Array<{ directionRef: string; firstStopTime: string; numVariants: number; firstStopName: string | null; lastStopName: string | null }>;
}

/** Delay profile for a logical journey identified by (lineRef, directionRef, firstStopTime).
 *
 *  Aggregates across ALL dated service journey IDs that share this
 *  departure time (i.e. all weeks + all days of that run), giving a true
 *  long-term average at each stop along the route.
 */
export async function getJourneyProfile(
  lineRef: string,
  directionRef: string,
  firstStopTime: string,
  fromWeek?: string,
  dayTypes?: DayType[] | null,
): Promise<Array<{ stopRef: string; stopSequence: number; aimedTime: string | null; avgDelayMin: number; maxDelayMin: number; minDelayMin: number; numSamples: number; numJourneys: number; stopName: string; avgDelayArrivalMin: number | null; avgDelayDepartureMin: number | null; avgDwellTimeSec: number | null; stddevDelayMin: number | null }>> {
  // Find ALL service_journey_ids that share this departure time.
  // One SJID per calendar date in SIRI ET — aggregate across all to get long-term stats.
  const dateClause = fromWeek ? "AND jsd.date >= ?" : "AND jsd.date >= date('now', '-91 days')";
  const sjBaseParams: any[] = fromWeek
    ? [lineRef, directionRef, fromWeek]
    : [lineRef, directionRef];

  const matchingSJs = sqlite
    .prepare(
      `SELECT DISTINCT service_journey_id
       FROM journey_stop_daily jsd
       WHERE jsd.line_ref = ? AND jsd.direction_ref = ? ${dateClause}
       GROUP BY service_journey_id
       HAVING MIN(COALESCE(jsd.aimed_departure, jsd.aimed_arrival)) = ?`,
    )
    .all(...sjBaseParams, firstStopTime) as Array<{ service_journey_id: string }>;

  if (matchingSJs.length === 0) return [];

  const placeholders = matchingSJs.map(() => "?").join(", ");
  const sjIds = matchingSJs.map((r) => r.service_journey_id);

  // Optional day_type filter
  const dtFilter =
    dayTypes && dayTypes.length
      ? `AND jsd.day_type IN (${dayTypes.map(() => "?").join(",")})`
      : "";
  const dtParams: string[] = dayTypes && dayTypes.length ? (dayTypes as string[]) : [];

  // Single unified query over journey_stop_daily — works with or without dayType filter.
  // d = COALESCE(delay_departure_min, delay_arrival_min) — combined delay, dep preferred.
  return sqlite
    .prepare(
      `SELECT
         jsd.stop_ref                                                              AS stopRef,
         MIN(jsd.stop_sequence)                                                    AS stopSequence,
         MIN(COALESCE(jsd.aimed_departure, jsd.aimed_arrival))                    AS aimedTime,
         ROUND(AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2)  AS avgDelayMin,
         ROUND(MAX(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2)  AS maxDelayMin,
         ROUND(MIN(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2)  AS minDelayMin,
         COUNT(*)                                                                  AS numSamples,
         COUNT(DISTINCT jsd.date)                                                  AS numJourneys,
         COALESCE(MAX(sc.stop_name), MAX(jsd.stop_ref))                           AS stopName,
         ROUND(AVG(jsd.delay_arrival_min), 2)                                     AS avgDelayArrivalMin,
         ROUND(AVG(jsd.delay_departure_min), 2)                                   AS avgDelayDepartureMin,
         ROUND(AVG(jsd.dwell_time_sec), 1)                                        AS avgDwellTimeSec,
         ROUND(SQRT(MAX(0,
           AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)
               * COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min))
           - AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min))
           * AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min))
         )), 2)                                                                    AS stddevDelayMin
       FROM journey_stop_daily jsd
       LEFT JOIN stop_coords sc ON sc.stop_ref = jsd.stop_ref
       WHERE jsd.service_journey_id IN (${placeholders})
         ${dtFilter}
       GROUP BY jsd.stop_ref
       ORDER BY MIN(COALESCE(jsd.aimed_departure, jsd.aimed_arrival)) ASC,
                MIN(jsd.stop_sequence) ASC`,
    )
    .all(...sjIds, ...dtParams) as any;
}

/** Worst stops on a line — aggregated across all service journeys on the line.
 *  Only includes stops with >= 20 samples (enough data to be meaningful).
 */
export async function getWorstStopsForLine(lineRef: string, fromWeek: string, limit = 15) {
  return sqlite
    .prepare(
      `SELECT
         jsd.stop_ref AS stopRef,
         COALESCE(MAX(sc.stop_name), MAX(jsd.stop_ref)) AS stopName,
         ROUND(AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2) AS avgDelayMin,
         COUNT(*) AS numSamples
       FROM journey_stop_daily jsd
       LEFT JOIN stop_coords sc ON sc.stop_ref = jsd.stop_ref
       WHERE jsd.line_ref = ? AND jsd.date >= ?
       GROUP BY jsd.stop_ref
       HAVING COUNT(*) >= 20
       ORDER BY avgDelayMin DESC
       LIMIT ?`,
    )
    .all(lineRef, fromWeek, limit);
}

/** Route variants for a line — groups service journeys by their stop set.
 *  Returns distinct route patterns with their first/last stop names and sample counts.
 *  Used to let users pick which variant to view on the route profile.
 */
export async function getRouteVariants(
  lineRef: string,
  directionRef: string,
  fromWeek: string,
): Promise<Array<{
  variantId: string;
  firstStopName: string | null;
  lastStopName: string | null;
  numStops: number;
  totalSamples: number;
  exampleTime: string | null;
}>> {
  // Group journeys by their stop count + first/last stop (proxy for route pattern)
  return sqlite.prepare(`
    SELECT
      first_stop_ref || '->' || last_stop_ref || ':' || num_stops AS variantId,
      MAX(first_stop_name) AS firstStopName,
      MAX(last_stop_name)  AS lastStopName,
      num_stops            AS numStops,
      SUM(total_samples)   AS totalSamples,
      MIN(first_time)      AS exampleTime
    FROM (
      SELECT
        jsd.service_journey_id,
        COUNT(DISTINCT jsd.stop_ref) AS num_stops,
        MIN(COALESCE(jsd.aimed_departure, jsd.aimed_arrival)) AS first_time,
        COUNT(*) AS total_samples,
        (SELECT j2.stop_ref FROM journey_stop_daily j2
         WHERE j2.service_journey_id = jsd.service_journey_id
         ORDER BY j2.stop_sequence ASC LIMIT 1) AS first_stop_ref,
        (SELECT j2.stop_ref FROM journey_stop_daily j2
         WHERE j2.service_journey_id = jsd.service_journey_id
         ORDER BY j2.stop_sequence DESC LIMIT 1) AS last_stop_ref,
        (SELECT COALESCE(sc.stop_name, j2.stop_ref)
         FROM journey_stop_daily j2
         LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
         WHERE j2.service_journey_id = jsd.service_journey_id
         ORDER BY j2.stop_sequence ASC LIMIT 1) AS first_stop_name,
        (SELECT COALESCE(sc.stop_name, j2.stop_ref)
         FROM journey_stop_daily j2
         LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
         WHERE j2.service_journey_id = jsd.service_journey_id
         ORDER BY j2.stop_sequence DESC LIMIT 1) AS last_stop_name
      FROM journey_stop_daily jsd
      WHERE jsd.line_ref = ? AND jsd.direction_ref = ? AND jsd.date >= ?
      GROUP BY jsd.service_journey_id
    )
    GROUP BY first_stop_ref, last_stop_ref, num_stops
    HAVING SUM(total_samples) >= 20
    ORDER BY totalSamples DESC
    LIMIT 20
  `).all(lineRef, directionRef, fromWeek) as any;
}

/** All stops on a line in route order with their average delay.
 *  Unlike getWorstStopsForLine (sorted by delay desc), this preserves the
 *  canonical stop sequence so you can visualise where delay builds up along
 *  the route. direction_ref is required because route order is direction-specific.
 *
 *  Ordering strategy: find the "dominant" serviceJourney (most samples) for the
 *  given variant and use its stop_sequence as canonical order. Only includes stops
 *  from journeys matching that variant's stop set.
 *
 *  If variantId is provided, filters to only journeys matching that route pattern.
 */
export async function getLineStopProfile(
  lineRef: string,
  directionRef: string,
  fromWeek: string,
  variantId?: string,
): Promise<Array<{
  stopRef: string;
  stopSequence: number;
  avgDelayMin: number | null;
  maxDelayMin: number | null;
  minDelayMin: number | null;
  numSamples: number;
  stopName: string | null;
}>> {
  // Step 1: Find the dominant service journey for canonical ordering.
  // If variantId given, filter to journeys matching that pattern (first_stop->last_stop:num_stops).
  let dominantSql: string;
  let dominantParams: any[];

  if (variantId) {
    // variantId format: "NSR:Quay:xxx->NSR:Quay:yyy:NN"
    const match = variantId.match(/^(.+)->(.+):(\d+)$/);
    if (match) {
      const [, firstStop, lastStop, numStops] = match;
      dominantSql = `
        SELECT jsd.service_journey_id
        FROM journey_stop_daily jsd
        WHERE jsd.line_ref = ? AND jsd.direction_ref = ? AND jsd.date >= ?
        GROUP BY jsd.service_journey_id
        HAVING COUNT(DISTINCT jsd.stop_ref) = ?
          AND (SELECT j2.stop_ref FROM journey_stop_daily j2
               WHERE j2.service_journey_id = jsd.service_journey_id
               ORDER BY j2.stop_sequence ASC LIMIT 1) = ?
          AND (SELECT j2.stop_ref FROM journey_stop_daily j2
               WHERE j2.service_journey_id = jsd.service_journey_id
               ORDER BY j2.stop_sequence DESC LIMIT 1) = ?
        ORDER BY COUNT(*) DESC
        LIMIT 1`;
      dominantParams = [lineRef, directionRef, fromWeek, parseInt(numStops), firstStop, lastStop];
    } else {
      dominantSql = `
        SELECT service_journey_id FROM journey_stop_daily
        WHERE line_ref = ? AND direction_ref = ? AND date >= ?
        GROUP BY service_journey_id ORDER BY COUNT(*) DESC LIMIT 1`;
      dominantParams = [lineRef, directionRef, fromWeek];
    }
  } else {
    dominantSql = `
      SELECT service_journey_id FROM journey_stop_daily
      WHERE line_ref = ? AND direction_ref = ? AND date >= ?
      GROUP BY service_journey_id ORDER BY COUNT(*) DESC LIMIT 1`;
    dominantParams = [lineRef, directionRef, fromWeek];
  }

  const dominant = sqlite.prepare(dominantSql).get(...dominantParams) as { service_journey_id: string } | undefined;
  if (!dominant) return [];

  // Step 2: Get the canonical stop set from the dominant journey
  const canonicalStops = sqlite.prepare(`
    SELECT stop_ref FROM journey_stop_daily
    WHERE service_journey_id = ?
    GROUP BY stop_ref
  `).all(dominant.service_journey_id) as Array<{ stop_ref: string }>;

  // Step 3: Query only stops that appear on the dominant journey's route,
  // but aggregate data from ALL matching journeys for those stops.
  const placeholders = canonicalStops.map(() => '?').join(',');

  return sqlite.prepare(`
    SELECT
      jsd.stop_ref           AS stopRef,
      (SELECT co.stop_sequence FROM journey_stop_daily co
       WHERE co.service_journey_id = ? AND co.stop_ref = jsd.stop_ref
       LIMIT 1)              AS stopSequence,
      ROUND(AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2) AS avgDelayMin,
      ROUND(MAX(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2) AS maxDelayMin,
      ROUND(MIN(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2) AS minDelayMin,
      ROUND(AVG(jsd.delay_arrival_min), 2)  AS avgDelayArrivalMin,
      ROUND(AVG(jsd.delay_departure_min), 2) AS avgDelayDepartureMin,
      ROUND(AVG(jsd.dwell_time_sec), 1)     AS avgDwellTimeSec,
      COUNT(*)                              AS numSamples,
      COALESCE(MAX(sc.stop_name), jsd.stop_ref) AS stopName
    FROM journey_stop_daily jsd
    LEFT JOIN stop_coords sc ON sc.stop_ref = jsd.stop_ref
    WHERE jsd.line_ref = ? AND jsd.direction_ref = ? AND jsd.date >= ?
      AND jsd.stop_ref IN (${placeholders})
    GROUP BY jsd.stop_ref
    HAVING COUNT(*) >= 3
    ORDER BY (SELECT co.stop_sequence FROM journey_stop_daily co
              WHERE co.service_journey_id = ? AND co.stop_ref = jsd.stop_ref
              LIMIT 1)
  `).all(
    dominant.service_journey_id,
    lineRef, directionRef, fromWeek,
    ...canonicalStops.map(s => s.stop_ref),
    dominant.service_journey_id,
  ) as any;
}

/** Worst (and best) individual scheduled departures for a line.
 *  Groups journey_stop_daily by service_journey_id, computes average
 *  delay across all stops, and returns sorted by avg delay descending/ascending.
 *  departure_time = aimed_departure/arrival at the stop with the lowest stop_sequence (origin).
 */
export async function getWorstJourneysForLine(
  lineRef: string,
  directionRef: string,
  fromWeek: string,
  limit = 15,
): Promise<Array<{
  serviceJourneyId: string;
  departureTime: string | null;
  firstStopName: string | null;
  lastStopName: string | null;
  avgDelayMin: number;
  observedDepartures: number;
  numStops: number;
}>> {
  return sqlite.prepare(`
    SELECT
      jsd.service_journey_id AS serviceJourneyId,
      (
        SELECT COALESCE(j2.aimed_departure, j2.aimed_arrival)
        FROM journey_stop_daily j2
        WHERE j2.service_journey_id = jsd.service_journey_id
          AND COALESCE(j2.aimed_departure, j2.aimed_arrival) IS NOT NULL
        ORDER BY j2.stop_sequence ASC
        LIMIT 1
      )                       AS departureTime,
      (
        SELECT COALESCE(sc.stop_name, j2.stop_ref)
        FROM journey_stop_daily j2
        LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
        WHERE j2.service_journey_id = jsd.service_journey_id
        ORDER BY j2.stop_sequence ASC
        LIMIT 1
      )                       AS firstStopName,
      (
        SELECT COALESCE(sc.stop_name, j2.stop_ref)
        FROM journey_stop_daily j2
        LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
        WHERE j2.service_journey_id = jsd.service_journey_id
        ORDER BY j2.stop_sequence DESC
        LIMIT 1
      )                       AS lastStopName,
      ROUND(AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2) AS avgDelayMin,
      COUNT(DISTINCT jsd.date)      AS observedDepartures,
      COUNT(DISTINCT jsd.stop_ref)  AS numStops
    FROM journey_stop_daily jsd
    WHERE jsd.line_ref = ? AND jsd.direction_ref = ? AND jsd.date >= ?
    GROUP BY jsd.service_journey_id
    HAVING numStops >= 3
    ORDER BY avgDelayMin DESC
    LIMIT ?
  `).all(lineRef, directionRef, fromWeek, limit) as any;
}

/** Best (least delayed / most punctual) individual scheduled departures for a line. */
export async function getBestJourneysForLine(
  lineRef: string,
  directionRef: string,
  fromWeek: string,
  limit = 15,
): Promise<Array<{
  serviceJourneyId: string;
  departureTime: string | null;
  firstStopName: string | null;
  lastStopName: string | null;
  avgDelayMin: number;
  observedDepartures: number;
  numStops: number;
}>> {
  return sqlite.prepare(`
    SELECT
      jsd.service_journey_id AS serviceJourneyId,
      (
        SELECT COALESCE(j2.aimed_departure, j2.aimed_arrival)
        FROM journey_stop_daily j2
        WHERE j2.service_journey_id = jsd.service_journey_id
          AND COALESCE(j2.aimed_departure, j2.aimed_arrival) IS NOT NULL
        ORDER BY j2.stop_sequence ASC
        LIMIT 1
      )                       AS departureTime,
      (
        SELECT COALESCE(sc.stop_name, j2.stop_ref)
        FROM journey_stop_daily j2
        LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
        WHERE j2.service_journey_id = jsd.service_journey_id
        ORDER BY j2.stop_sequence ASC
        LIMIT 1
      )                       AS firstStopName,
      (
        SELECT COALESCE(sc.stop_name, j2.stop_ref)
        FROM journey_stop_daily j2
        LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
        WHERE j2.service_journey_id = jsd.service_journey_id
        ORDER BY j2.stop_sequence DESC
        LIMIT 1
      )                       AS lastStopName,
      ROUND(AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2) AS avgDelayMin,
      COUNT(DISTINCT jsd.date)      AS observedDepartures,
      COUNT(DISTINCT jsd.stop_ref)  AS numStops
    FROM journey_stop_daily jsd
    WHERE jsd.line_ref = ? AND jsd.direction_ref = ? AND jsd.date >= ?
    GROUP BY jsd.service_journey_id
    HAVING numStops >= 3
    ORDER BY avgDelayMin ASC
    LIMIT ?
  `).all(lineRef, directionRef, fromWeek, limit) as any;
}

/** Lines serving a stop with their avg delay (from journey_stop_daily).
 *  Used to filter stop analysis by line and show which lines drive delay.
 */
export async function getLineHourlyAtStop(
  stopRef: string,
  fromWeek: string,
): Promise<Array<{ lineRef: string; hour: number; avgDelayMin: number; numSamples: number }>> {
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `stop_ref = ?`;
  return sqlite
    .prepare(
      `SELECT
         line_ref AS lineRef,
         CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER) AS hour,
         ROUND(AVG(COALESCE(delay_departure_min, delay_arrival_min)), 2) AS avgDelayMin,
         COUNT(*) AS numSamples
       FROM journey_stop_daily
       WHERE ${stopFilter} AND date >= ?
         AND COALESCE(aimed_departure, aimed_arrival) IS NOT NULL
       GROUP BY line_ref, CAST(SUBSTR(COALESCE(aimed_departure, aimed_arrival), 1, 2) AS INTEGER)
       ORDER BY line_ref, hour`,
    )
    .all(stopRef, fromWeek) as any;
}

export async function getLinesAtStop(stopRef: string, fromWeek: string) {
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `jsd.stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `jsd.stop_ref = ?`;
  return sqlite.prepare(`
    SELECT
      jsd.line_ref AS lineRef,
      ROUND(AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2) AS avgDelayMin,
      COUNT(*) AS numSamples
    FROM journey_stop_daily jsd
    WHERE ${stopFilter} AND jsd.date >= ?
    GROUP BY jsd.line_ref
    ORDER BY avgDelayMin DESC
  `).all(stopRef, fromWeek) as any;
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

export async function getLeaderboardLines(type: "worst" | "best", operator?: string, limit = 10) {
  const order =
    type === "worst"
      ? desc(schema.leaderboardLines.avgDelayMin)
      : schema.leaderboardLines.avgDelayMin;
  return db
    .select()
    .from(schema.leaderboardLines)
    .where(operator ? like(schema.leaderboardLines.lineRef, `${operator}:%`) : undefined)
    .orderBy(order)
    .limit(limit)
    .all();
}

/** Reliability leaderboard: lines sorted by stddev (low = reliable, high = unpredictable). */
export async function getLeaderboardLinesByReliability(
  type: "reliable" | "unreliable",
  operator?: string,
  limit = 10,
) {
  const order =
    type === "unreliable"
      ? desc(schema.leaderboardLines.stddevDelayMin)
      : schema.leaderboardLines.stddevDelayMin;
  return db
    .select()
    .from(schema.leaderboardLines)
    .where(
      and(
        operator ? like(schema.leaderboardLines.lineRef, `${operator}:%`) : undefined,
        sql`${schema.leaderboardLines.stddevDelayMin} IS NOT NULL`,
        sql`${schema.leaderboardLines.totalDepartures} >= 500`,
      ),
    )
    .orderBy(order)
    .limit(limit)
    .all();
}

export async function getLeaderboardLinesPeriod(
  type: "worst" | "best",
  fromDate: string,
  operator?: string,
  limit = 10,
) {
  const avgExpr = sql<number>`ROUND(SUM(${schema.lineDaily.avgDelayMin} * ${schema.lineDaily.numDepartures}) * 1.0 / SUM(${schema.lineDaily.numDepartures}), 2)`;
  const order = type === "worst" ? desc(avgExpr) : avgExpr;

  return db
    .select({
      lineRef: schema.lineDaily.lineRef,
      lineName: schema.lineDaily.lineName,
      avgDelayMin: avgExpr,
      totalDepartures: sql<number>`SUM(${schema.lineDaily.numDepartures})`,
    })
    .from(schema.lineDaily)
    .where(
      operator
        ? and(gte(schema.lineDaily.date, fromDate), inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[]), like(schema.lineDaily.lineRef, `${operator}:%`))
        : and(gte(schema.lineDaily.date, fromDate), inArray(schema.lineDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[])),
    )
    .groupBy(schema.lineDaily.lineRef, schema.lineDaily.lineName)
    .orderBy(order)
    .limit(limit)
    .all();
}

export async function getLeaderboardStops(
  type: "worst" | "best" = "worst",
  fromDate: string,
  operator = "SKY",
  limit = 10,
  toDate?: string,
) {
  const avgExpr = sql<number>`ROUND(SUM(${schema.stopDaily.avgDelayMin} * ${schema.stopDaily.numDepartures}) * 1.0 / SUM(${schema.stopDaily.numDepartures}), 2)`;
  const pctExpr = sql<number>`ROUND(SUM(${schema.stopDaily.pctDelayed2plus} * ${schema.stopDaily.numDepartures}) * 1.0 / SUM(${schema.stopDaily.numDepartures}), 1)`;
  const order = type === "worst" ? desc(avgExpr) : avgExpr;

  return db
    .select({
      stopRef: schema.stopDaily.stopRef,
      stopName: sql<string>`COALESCE(MAX(${schema.stopCoords.stopName}), MAX(${schema.stopDaily.stopName}))`,
      avgDelayMin: avgExpr,
      pctDelayed2plus: pctExpr,
      totalDepartures: sql<number>`SUM(${schema.stopDaily.numDepartures})`,
    })
    .from(schema.stopDaily)
    .leftJoin(schema.stopCoords, eq(schema.stopCoords.stopRef, schema.stopDaily.stopRef))
    .where(
      and(
        gte(schema.stopDaily.date, fromDate),
        toDate ? lte(schema.stopDaily.date, toDate) : undefined,
        inArray(schema.stopDaily.vehicleMode, INCLUDED_MODES as readonly string[] as string[]),
        eq(schema.stopDaily.operator, operator),
        like(schema.stopDaily.stopRef, "NSR:%"),
      ),
    )
    .groupBy(schema.stopDaily.stopRef)
    .having(sql`SUM(${schema.stopDaily.numDepartures}) >= 100`)
    .orderBy(order)
    .limit(limit)
    .all();
}

/**
 * Worst/best days: when from/to are set, aggregate live from daily_summary.
 * Otherwise, use the materialized worst_days table (for default all-time view).
 * dayTypes filters by day type (weekday/saturday/sunday/holiday/may17) on the materialized table.
 */
export async function getWorstDays(limit = 10, operator = "SKY", fromDate?: string, toDate?: string, dayTypes?: DayType[] | null) {
  if (fromDate || toDate) {
    return db
      .select()
      .from(schema.dailySummary)
      .where(
        and(
          eq(schema.dailySummary.operator, operator),
          fromDate ? gte(schema.dailySummary.date, fromDate) : undefined,
          toDate ? lte(schema.dailySummary.date, toDate) : undefined,
        ),
      )
      .orderBy(desc(schema.dailySummary.avgDelayMin))
      .limit(limit)
      .all();
  }
  return db
    .select()
    .from(schema.worstDays)
    .where(
      and(
        eq(schema.worstDays.operator, operator),
        dayTypes && dayTypes.length
          ? inArray(schema.worstDays.dayType, dayTypes as readonly string[] as string[])
          : undefined,
      ),
    )
    .orderBy(desc(schema.worstDays.avgDelayMin))
    .limit(limit)
    .all();
}

export async function getBestDays(limit = 10, operator = "SKY", fromDate?: string, toDate?: string) {
  return db
    .select()
    .from(schema.dailySummary)
    .where(
      and(
        eq(schema.dailySummary.operator, operator),
        fromDate ? gte(schema.dailySummary.date, fromDate) : undefined,
        toDate ? lte(schema.dailySummary.date, toDate) : undefined,
      ),
    )
    .orderBy(schema.dailySummary.avgDelayMin)
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

/** Returns data quality warnings for a given date and operator.
 *  Optionally filtered by lineRef or stopRef to show page-relevant warnings.
 *  type: 'outlier_delay' | 'missing_time'
 */
export async function getDataQuality(
  date: string,
  operator = "SKY",
  lineRef?: string,
  stopRef?: string,
): Promise<Array<{
  id: number;
  type: string;
  lineRef: string | null;
  serviceJourneyId: string | null;
  stopRef: string | null;
  aimedTime: string | null;
  delayMin: number | null;
  count: number;
  total: number | null;
  message: string;
}>> {
  const conditions: string[] = ["date = ? AND operator = ?"];
  const params: (string | null)[] = [date, operator];

  if (lineRef) {
    conditions.push("(line_ref = ? OR type = 'missing_time')");
    params.push(lineRef);
  }
  if (stopRef) {
    conditions.push("(stop_ref = ? OR type = 'missing_time')");
    params.push(stopRef);
  }

  const query = `
    SELECT id, type,
           line_ref AS lineRef,
           service_journey_id AS serviceJourneyId,
           stop_ref AS stopRef,
           aimed_time AS aimedTime,
           delay_min AS delayMin,
           count, total, message
    FROM data_quality_log
    WHERE ${conditions.join(" AND ")}
    ORDER BY type, ABS(delay_min) DESC
  `;
  return sqlite.prepare(query).all(...params) as any;
}


// ---------------------------------------------------------------------------
// Corridor comparison — multi-line delay at shared stops
// ---------------------------------------------------------------------------

/** Given a list of lines and an ordered list of stop_refs (the corridor),
 *  return delay data at each stop for each line. Used by /reise page.
 *
 *  Input: corridor = [{lineRef, stopRefs: string[]}]
 *  Each entry represents one transit option with its ordered stop list.
 *  Returns flat array: {lineRef, stopRef, stopName, corridorIndex, avgDelayMin, ...}
 */
export async function getCorridorComparison(
  corridor: Array<{ lineRef: string; stopRefs: string[] }>,
  fromWeek: string,
): Promise<Array<{
  lineRef: string;
  stopRef: string;
  stopName: string | null;
  corridorIndex: number;
  avgDelayMin: number | null;
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  avgDwellTimeSec: number | null;
  numSamples: number;
}>> {
  const results: Array<{
    lineRef: string;
    stopRef: string;
    stopName: string | null;
    corridorIndex: number;
    avgDelayMin: number | null;
    avgDelayArrivalMin: number | null;
    avgDelayDepartureMin: number | null;
    avgDwellTimeSec: number | null;
    numSamples: number;
  }> = [];

  for (const entry of corridor) {
    if (entry.stopRefs.length === 0) continue;
    const placeholders = entry.stopRefs.map(() => '?').join(',');

    const rows = sqlite.prepare(`
      SELECT
        jsd.stop_ref AS stopRef,
        COALESCE(MAX(sc.stop_name), MAX(jsd.stop_ref)) AS stopName,
        ROUND(AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2) AS avgDelayMin,
        ROUND(AVG(jsd.delay_arrival_min), 2) AS avgDelayArrivalMin,
        ROUND(AVG(jsd.delay_departure_min), 2) AS avgDelayDepartureMin,
        ROUND(AVG(jsd.dwell_time_sec), 1) AS avgDwellTimeSec,
        COUNT(*) AS numSamples
      FROM journey_stop_daily jsd
      LEFT JOIN stop_coords sc ON sc.stop_ref = jsd.stop_ref
      WHERE jsd.line_ref = ? AND jsd.date >= ?
        AND jsd.stop_ref IN (${placeholders})
      GROUP BY jsd.stop_ref
    `).all(entry.lineRef, fromWeek, ...entry.stopRefs) as any[];

    // Build a lookup for this line's stop data
    const stopMap = new Map(rows.map((r: any) => [r.stopRef, r]));

    // Output in corridor order (the order from the journey planner)
    entry.stopRefs.forEach((stopRef, idx) => {
      const data = stopMap.get(stopRef);
      results.push({
        lineRef: entry.lineRef,
        stopRef,
        stopName: data?.stopName ?? null,
        corridorIndex: idx,
        avgDelayMin: data?.avgDelayMin ?? null,
        avgDelayArrivalMin: data?.avgDelayArrivalMin ?? null,
        avgDelayDepartureMin: data?.avgDelayDepartureMin ?? null,
        avgDwellTimeSec: data?.avgDwellTimeSec ?? null,
        numSamples: data?.numSamples ?? 0,
      });
    });
  }

  return results;
}

/** Search for stops by name — used by the trip planner stop picker.
 *  Only returns stops with a known NSR:StopPlace ref (required by Entur JP API).
 *  Groups by stop_place_ref so each StopPlace appears once.
 *  Includes quay count to help differentiate same-name StopPlaces (e.g. bybane vs buss).
 */
export async function searchStopsForCorridor(
  query: string,
  limit = 10,
): Promise<Array<{ stopRef: string; stopPlaceRef: string; stopName: string; lat: number | null; lng: number | null; quayCount: number }>> {
  return sqlite.prepare(`
    SELECT
      sc.stop_place_ref AS stopRef,
      sc.stop_place_ref AS stopPlaceRef,
      COALESCE(sc.stop_place_name, sc.stop_name) AS stopName,
      AVG(sc.lat) AS lat,
      AVG(sc.lng) AS lng,
      COUNT(sc.stop_ref) AS quayCount
    FROM stop_coords sc
    WHERE (sc.stop_name LIKE ? OR sc.stop_place_name LIKE ?)
      AND sc.stop_ref LIKE 'NSR:%'
      AND sc.stop_place_ref IS NOT NULL
    GROUP BY sc.stop_place_ref
    ORDER BY stopName, quayCount DESC
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit) as any;
}

// ---------------------------------------------------------------------------
// Trip planner — delay stats overlay for Entur trip suggestions
// ---------------------------------------------------------------------------

/**
 * Look up historical delay stats from journey_stop_daily for a list of
 * (stopRef, lineRef) pairs. Returns avg delay, sample count, and stddev
 * for each pair — used to annotate Entur trip legs with "how late is
 * this line typically at this stop?"
 */
export async function getTripStopStats(
  stops: Array<{ stopRef: string; lineRef: string }>,
): Promise<Array<{
  stopRef: string;
  lineRef: string;
  avgDelayMin: number | null;
  avgDelayArrivalMin: number | null;
  avgDelayDepartureMin: number | null;
  avgDwellTimeSec: number | null;
  numSamples: number | null;
}>> {
  if (stops.length === 0) return [];

  // Build a single query with OR conditions for each (stopRef, lineRef) pair.
  // journey_stop_daily has a 90-day rolling window — aggregate across all rows.
  const conditions = stops
    .map(() => `(jsd.stop_ref = ? AND jsd.line_ref = ?)`)
    .join(" OR ");
  const params = stops.flatMap((s) => [s.stopRef, s.lineRef]);

  const rows = sqlite.prepare(`
    SELECT
      jsd.stop_ref AS stopRef,
      jsd.line_ref AS lineRef,
      ROUND(AVG(COALESCE(jsd.delay_departure_min, jsd.delay_arrival_min)), 2) AS avgDelayMin,
      ROUND(AVG(jsd.delay_arrival_min), 2) AS avgDelayArrivalMin,
      ROUND(AVG(jsd.delay_departure_min), 2) AS avgDelayDepartureMin,
      ROUND(AVG(jsd.dwell_time_sec), 1) AS avgDwellTimeSec,
      COUNT(*) AS numSamples
    FROM journey_stop_daily jsd
    WHERE jsd.date >= date('now', '-91 days')
      AND (${conditions})
    GROUP BY jsd.stop_ref, jsd.line_ref
  `).all(...params) as any;

  return rows;
}
