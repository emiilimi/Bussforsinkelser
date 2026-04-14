import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { desc, eq, gte, lte, and, like, sql, notInArray } from "drizzle-orm";
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
    .where(and(eq(schema.lineDaily.date, date), eq(schema.lineDaily.vehicleMode, "bus")))
    .groupBy(schema.lineDaily.lineRef, schema.lineDaily.lineName)
    .orderBy(desc(avgExpr))
    .limit(limit)
    .all();
}

export async function getLineStats(lineRef: string, fromDate: string, direction?: string) {
  // One aggregated row per date. When direction is a specific value (not 'all' or undefined),
  // filter to that direction only. When 'all' or undefined, aggregate all directions.
  const baseConditions = and(
    eq(schema.lineDaily.lineRef, lineRef),
    gte(schema.lineDaily.date, fromDate),
    eq(schema.lineDaily.vehicleMode, "bus"),
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

export async function getLineHourlyProfile(lineRef: string, direction?: string) {
  // When direction is a specific value (not 'all' or undefined): return that direction's profile.
  // When 'all' or undefined: aggregate all directions (weighted avg + max/min over all).
  if (direction && direction !== "all") {
    return db
      .select()
      .from(schema.lineHourlyProfile)
      .where(
        and(
          eq(schema.lineHourlyProfile.lineRef, lineRef),
          eq(schema.lineHourlyProfile.directionRef, direction),
        ),
      )
      .orderBy(schema.lineHourlyProfile.hour)
      .all();
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
        eq(schema.lineDaily.vehicleMode, "bus"),
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

export async function getStopStats(stopRef: string, fromDate: string, operator = "SKY", direction?: string) {
  // stopRef can be either NSR:Quay:XXXXX (single quay) or NSR:StopPlace:XXXXX
  // (parent stop place, which groups multiple quays together in search results).
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `sd.stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `sd.stop_ref = ?`;

  // 'all': aggregate across directions (and across quays if stop place)
  if (!direction || direction === "all") {
    return sqlite.prepare(`
      SELECT
        sd.date,
        ? AS stopRef,
        COALESCE(MAX(sc.stop_place_name), MAX(sc.stop_name), MAX(sd.stop_name)) AS stopName,
        ROUND(SUM(sd.avg_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS avgDelayMin,
        ROUND(MAX(sd.max_delay_min), 2) AS maxDelayMin,
        ROUND(MIN(sd.min_delay_min), 2) AS minDelayMin,
        ROUND(SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 1) AS pctDelayed2plus,
        SUM(sd.num_departures) AS numDepartures
      FROM stop_daily sd
      LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
      WHERE ${stopFilter} AND sd.date >= ? AND sd.vehicle_mode = 'bus' AND sd.operator = ?
      GROUP BY sd.date
      ORDER BY sd.date
    `).all(stopRef, stopRef, fromDate, operator) as any[];
  }

  // Direction-specific: aggregate quays if stop place, keep direction filter
  return sqlite.prepare(`
    SELECT
      sd.date,
      ? AS stopRef,
      COALESCE(MAX(sc.stop_place_name), MAX(sc.stop_name), MAX(sd.stop_name)) AS stopName,
      ROUND(SUM(sd.avg_delay_min * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 2) AS avgDelayMin,
      ROUND(MAX(sd.max_delay_min), 2) AS maxDelayMin,
      ROUND(MIN(sd.min_delay_min), 2) AS minDelayMin,
      ROUND(SUM(sd.pct_delayed_2plus * sd.num_departures) * 1.0 / NULLIF(SUM(sd.num_departures), 0), 1) AS pctDelayed2plus,
      SUM(sd.num_departures) AS numDepartures
    FROM stop_daily sd
    LEFT JOIN stop_coords sc ON sc.stop_ref = sd.stop_ref
    WHERE ${stopFilter} AND sd.date >= ? AND sd.vehicle_mode = 'bus' AND sd.operator = ? AND sd.direction_ref = ?
    GROUP BY sd.date
    ORDER BY sd.date
  `).all(stopRef, stopRef, fromDate, operator, direction) as any[];
}

export async function getStopHourlyProfile(stopRef: string, operator = "SKY", direction?: string) {
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `stop_ref = ?`;

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
    GROUP BY hour
    ORDER BY hour
  `).all(stopRef, operator, direction);
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
      AND sd.vehicle_mode = 'bus'
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
      AND sd.vehicle_mode = 'bus'
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
         direction_ref  AS directionRef,
         first_stop_time AS firstStopTime,
         COUNT(*)        AS numVariants,
         MAX(first_stop_name) AS firstStopName,
         MAX(last_stop_name)  AS lastStopName
       FROM (
         SELECT
           jsw.service_journey_id,
           jsw.direction_ref,
           MIN(jsw.aimed_time) AS first_stop_time,
           (SELECT COALESCE(sc1.stop_name, jsw1.stop_ref)
            FROM journey_stop_weekly jsw1
            LEFT JOIN stop_coords sc1 ON sc1.stop_ref = jsw1.stop_ref
            WHERE jsw1.service_journey_id = jsw.service_journey_id
            ORDER BY jsw1.stop_sequence ASC LIMIT 1) AS first_stop_name,
           (SELECT COALESCE(sc2.stop_name, jsw2.stop_ref)
            FROM journey_stop_weekly jsw2
            LEFT JOIN stop_coords sc2 ON sc2.stop_ref = jsw2.stop_ref
            WHERE jsw2.service_journey_id = jsw.service_journey_id
            ORDER BY jsw2.stop_sequence DESC LIMIT 1) AS last_stop_name
         FROM journey_stop_weekly jsw
         WHERE jsw.line_ref = ? AND jsw.week_start >= ?
         GROUP BY jsw.service_journey_id, jsw.direction_ref
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
): Promise<Array<{ stopRef: string; stopSequence: number; aimedTime: string | null; avgDelayMin: number; maxDelayMin: number; minDelayMin: number; numSamples: number; stopName: string }>> {
  // Find matching service_journey_ids, then pick the one with the most data
  // to avoid mixing stop_sequences from different route variants.
  const bestJourney = sqlite
    .prepare(
      `SELECT service_journey_id
       FROM journey_stop_weekly
       WHERE line_ref = ? AND direction_ref = ?
       GROUP BY service_journey_id
       HAVING MIN(aimed_time) = ?
       ORDER BY SUM(num_samples) DESC
       LIMIT 1`,
    )
    .get(lineRef, directionRef, firstStopTime) as { service_journey_id: string } | undefined;

  if (!bestJourney) return [];

  // For a single serviceJourney, sort by aimed_time (the true chronological order)
  // rather than stop_sequence which can be inconsistent across weeks.
  return sqlite
    .prepare(
      `SELECT
         jsw.stop_ref        AS stopRef,
         jsw.stop_sequence   AS stopSequence,
         jsw.aimed_time      AS aimedTime,
         ROUND(
           SUM(jsw.avg_delay_min * jsw.num_samples) * 1.0 / SUM(jsw.num_samples),
           2
         ) AS avgDelayMin,
         ROUND(MAX(jsw.max_delay_min), 2) AS maxDelayMin,
         ROUND(MIN(jsw.min_delay_min), 2) AS minDelayMin,
         SUM(jsw.num_samples) AS numSamples,
         COALESCE(MAX(sc.stop_name), jsw.stop_ref) AS stopName
       FROM journey_stop_weekly jsw
       LEFT JOIN stop_coords sc ON sc.stop_ref = jsw.stop_ref
       WHERE jsw.service_journey_id = ?
       GROUP BY jsw.stop_ref
       ORDER BY MAX(jsw.aimed_time) ASC, MIN(jsw.stop_sequence) ASC`,
    )
    .all(bestJourney.service_journey_id) as any;
}

/** Worst stops on a line — aggregated across all service journeys on the line.
 *  Only includes stops with >= 20 samples (enough data to be meaningful).
 */
export async function getWorstStopsForLine(lineRef: string, fromWeek: string, limit = 15) {
  const avgExpr = sql<number>`ROUND(SUM(${schema.journeyStopWeekly.avgDelayMin} * ${schema.journeyStopWeekly.numSamples}) * 1.0 / SUM(${schema.journeyStopWeekly.numSamples}), 2)`;
  return db
    .select({
      stopRef: schema.journeyStopWeekly.stopRef,
      stopName: sql<string>`COALESCE(MAX(${schema.stopCoords.stopName}), MAX(${schema.journeyStopWeekly.stopRef}))`,
      avgDelayMin: avgExpr,
      numSamples: sql<number>`SUM(${schema.journeyStopWeekly.numSamples})`,
    })
    .from(schema.journeyStopWeekly)
    .leftJoin(schema.stopCoords, eq(schema.stopCoords.stopRef, schema.journeyStopWeekly.stopRef))
    .where(
      and(
        eq(schema.journeyStopWeekly.lineRef, lineRef),
        gte(schema.journeyStopWeekly.weekStart, fromWeek),
      ),
    )
    .groupBy(schema.journeyStopWeekly.stopRef)
    .having(sql`SUM(${schema.journeyStopWeekly.numSamples}) >= 20`)
    .orderBy(desc(avgExpr))
    .limit(limit)
    .all();
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
        jsw.service_journey_id,
        COUNT(DISTINCT jsw.stop_ref) AS num_stops,
        MIN(jsw.aimed_time) AS first_time,
        SUM(jsw.num_samples) AS total_samples,
        (SELECT j2.stop_ref FROM journey_stop_weekly j2
         WHERE j2.service_journey_id = jsw.service_journey_id
         ORDER BY j2.stop_sequence ASC LIMIT 1) AS first_stop_ref,
        (SELECT j2.stop_ref FROM journey_stop_weekly j2
         WHERE j2.service_journey_id = jsw.service_journey_id
         ORDER BY j2.stop_sequence DESC LIMIT 1) AS last_stop_ref,
        (SELECT COALESCE(sc.stop_name, j2.stop_ref)
         FROM journey_stop_weekly j2
         LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
         WHERE j2.service_journey_id = jsw.service_journey_id
         ORDER BY j2.stop_sequence ASC LIMIT 1) AS first_stop_name,
        (SELECT COALESCE(sc.stop_name, j2.stop_ref)
         FROM journey_stop_weekly j2
         LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
         WHERE j2.service_journey_id = jsw.service_journey_id
         ORDER BY j2.stop_sequence DESC LIMIT 1) AS last_stop_name
      FROM journey_stop_weekly jsw
      WHERE jsw.line_ref = ? AND jsw.direction_ref = ? AND jsw.week_start >= ?
      GROUP BY jsw.service_journey_id
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
        SELECT jsw.service_journey_id
        FROM journey_stop_weekly jsw
        WHERE jsw.line_ref = ? AND jsw.direction_ref = ? AND jsw.week_start >= ?
        GROUP BY jsw.service_journey_id
        HAVING COUNT(DISTINCT jsw.stop_ref) = ?
          AND (SELECT j2.stop_ref FROM journey_stop_weekly j2
               WHERE j2.service_journey_id = jsw.service_journey_id
               ORDER BY j2.stop_sequence ASC LIMIT 1) = ?
          AND (SELECT j2.stop_ref FROM journey_stop_weekly j2
               WHERE j2.service_journey_id = jsw.service_journey_id
               ORDER BY j2.stop_sequence DESC LIMIT 1) = ?
        ORDER BY SUM(jsw.num_samples) DESC
        LIMIT 1`;
      dominantParams = [lineRef, directionRef, fromWeek, parseInt(numStops), firstStop, lastStop];
    } else {
      dominantSql = `
        SELECT service_journey_id FROM journey_stop_weekly
        WHERE line_ref = ? AND direction_ref = ? AND week_start >= ?
        GROUP BY service_journey_id ORDER BY SUM(num_samples) DESC LIMIT 1`;
      dominantParams = [lineRef, directionRef, fromWeek];
    }
  } else {
    dominantSql = `
      SELECT service_journey_id FROM journey_stop_weekly
      WHERE line_ref = ? AND direction_ref = ? AND week_start >= ?
      GROUP BY service_journey_id ORDER BY SUM(num_samples) DESC LIMIT 1`;
    dominantParams = [lineRef, directionRef, fromWeek];
  }

  const dominant = sqlite.prepare(dominantSql).get(...dominantParams) as { service_journey_id: string } | undefined;
  if (!dominant) return [];

  // Step 2: Get the canonical stop set from the dominant journey
  const canonicalStops = sqlite.prepare(`
    SELECT stop_ref FROM journey_stop_weekly
    WHERE service_journey_id = ?
    GROUP BY stop_ref
  `).all(dominant.service_journey_id) as Array<{ stop_ref: string }>;
  const stopSet = new Set(canonicalStops.map(s => s.stop_ref));

  // Step 3: Query only stops that appear on the dominant journey's route,
  // but aggregate data from ALL matching journeys for those stops.
  const placeholders = canonicalStops.map(() => '?').join(',');

  return sqlite.prepare(`
    SELECT
      jsw.stop_ref           AS stopRef,
      (SELECT co.stop_sequence FROM journey_stop_weekly co
       WHERE co.service_journey_id = ? AND co.stop_ref = jsw.stop_ref
       LIMIT 1)              AS stopSequence,
      ROUND(SUM(jsw.avg_delay_min * jsw.num_samples) * 1.0
            / NULLIF(SUM(jsw.num_samples), 0), 2)   AS avgDelayMin,
      ROUND(MAX(jsw.max_delay_min), 2)               AS maxDelayMin,
      ROUND(MIN(jsw.min_delay_min), 2)               AS minDelayMin,
      ROUND(SUM(CASE WHEN jsw.avg_delay_arrival_min IS NOT NULL
            THEN jsw.avg_delay_arrival_min * jsw.num_samples ELSE 0 END) * 1.0
            / NULLIF(SUM(CASE WHEN jsw.avg_delay_arrival_min IS NOT NULL
            THEN jsw.num_samples ELSE 0 END), 0), 2)  AS avgDelayArrivalMin,
      ROUND(SUM(CASE WHEN jsw.avg_delay_departure_min IS NOT NULL
            THEN jsw.avg_delay_departure_min * jsw.num_samples ELSE 0 END) * 1.0
            / NULLIF(SUM(CASE WHEN jsw.avg_delay_departure_min IS NOT NULL
            THEN jsw.num_samples ELSE 0 END), 0), 2)  AS avgDelayDepartureMin,
      ROUND(SUM(CASE WHEN jsw.avg_dwell_time_sec IS NOT NULL
            THEN jsw.avg_dwell_time_sec * jsw.num_samples ELSE 0 END) * 1.0
            / NULLIF(SUM(CASE WHEN jsw.avg_dwell_time_sec IS NOT NULL
            THEN jsw.num_samples ELSE 0 END), 0), 1)  AS avgDwellTimeSec,
      SUM(jsw.num_samples)                           AS numSamples,
      COALESCE(MAX(sc.stop_name), jsw.stop_ref)      AS stopName
    FROM journey_stop_weekly jsw
    LEFT JOIN stop_coords sc ON sc.stop_ref = jsw.stop_ref
    WHERE jsw.line_ref = ? AND jsw.direction_ref = ? AND jsw.week_start >= ?
      AND jsw.stop_ref IN (${placeholders})
    GROUP BY jsw.stop_ref
    HAVING SUM(jsw.num_samples) >= 3
    ORDER BY (SELECT co.stop_sequence FROM journey_stop_weekly co
              WHERE co.service_journey_id = ? AND co.stop_ref = jsw.stop_ref
              LIMIT 1)
  `).all(
    dominant.service_journey_id,
    lineRef, directionRef, fromWeek,
    ...canonicalStops.map(s => s.stop_ref),
    dominant.service_journey_id,
  ) as any;
}

/** Worst (and best) individual scheduled departures for a line.
 *  Groups journey_stop_weekly by service_journey_id, computes weighted average
 *  delay across all stops, and returns sorted by avg delay descending/ascending.
 *  departure_time = aimed_time at the stop with the lowest stop_sequence (origin).
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
      jsw.service_journey_id  AS serviceJourneyId,
      (
        SELECT j2.aimed_time
        FROM journey_stop_weekly j2
        WHERE j2.service_journey_id = jsw.service_journey_id
          AND j2.aimed_time IS NOT NULL
        ORDER BY j2.stop_sequence ASC
        LIMIT 1
      )                        AS departureTime,
      (
        SELECT COALESCE(sc.stop_name, j2.stop_ref)
        FROM journey_stop_weekly j2
        LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
        WHERE j2.service_journey_id = jsw.service_journey_id
        ORDER BY j2.stop_sequence ASC
        LIMIT 1
      )                        AS firstStopName,
      (
        SELECT COALESCE(sc.stop_name, j2.stop_ref)
        FROM journey_stop_weekly j2
        LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
        WHERE j2.service_journey_id = jsw.service_journey_id
        ORDER BY j2.stop_sequence DESC
        LIMIT 1
      )                        AS lastStopName,
      ROUND(
        SUM(jsw.avg_delay_min * jsw.num_samples) * 1.0
        / NULLIF(SUM(jsw.num_samples), 0), 2
      )                        AS avgDelayMin,
      MAX(jsw.num_samples)     AS observedDepartures,
      COUNT(DISTINCT jsw.stop_ref) AS numStops
    FROM journey_stop_weekly jsw
    WHERE jsw.line_ref = ? AND jsw.direction_ref = ? AND jsw.week_start >= ?
    GROUP BY jsw.service_journey_id
    HAVING observedDepartures >= 3
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
      jsw.service_journey_id  AS serviceJourneyId,
      (
        SELECT j2.aimed_time
        FROM journey_stop_weekly j2
        WHERE j2.service_journey_id = jsw.service_journey_id
          AND j2.aimed_time IS NOT NULL
        ORDER BY j2.stop_sequence ASC
        LIMIT 1
      )                        AS departureTime,
      (
        SELECT COALESCE(sc.stop_name, j2.stop_ref)
        FROM journey_stop_weekly j2
        LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
        WHERE j2.service_journey_id = jsw.service_journey_id
        ORDER BY j2.stop_sequence ASC
        LIMIT 1
      )                        AS firstStopName,
      (
        SELECT COALESCE(sc.stop_name, j2.stop_ref)
        FROM journey_stop_weekly j2
        LEFT JOIN stop_coords sc ON sc.stop_ref = j2.stop_ref
        WHERE j2.service_journey_id = jsw.service_journey_id
        ORDER BY j2.stop_sequence DESC
        LIMIT 1
      )                        AS lastStopName,
      ROUND(
        SUM(jsw.avg_delay_min * jsw.num_samples) * 1.0
        / NULLIF(SUM(jsw.num_samples), 0), 2
      )                        AS avgDelayMin,
      MAX(jsw.num_samples)     AS observedDepartures,
      COUNT(DISTINCT jsw.stop_ref) AS numStops
    FROM journey_stop_weekly jsw
    WHERE jsw.line_ref = ? AND jsw.direction_ref = ? AND jsw.week_start >= ?
    GROUP BY jsw.service_journey_id
    HAVING observedDepartures >= 3
    ORDER BY avgDelayMin ASC
    LIMIT ?
  `).all(lineRef, directionRef, fromWeek, limit) as any;
}

/** Lines serving a stop with their avg delay (from journey_stop_weekly).
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
         CAST(SUBSTR(aimed_time, 1, 2) AS INTEGER) AS hour,
         ROUND(
           SUM(avg_delay_min * num_samples) * 1.0 / NULLIF(SUM(num_samples), 0),
           2
         ) AS avgDelayMin,
         SUM(num_samples) AS numSamples
       FROM journey_stop_weekly
       WHERE ${stopFilter} AND week_start >= ? AND aimed_time IS NOT NULL
       GROUP BY line_ref, CAST(SUBSTR(aimed_time, 1, 2) AS INTEGER)
       ORDER BY line_ref, hour`,
    )
    .all(stopRef, fromWeek) as any;
}

export async function getLinesAtStop(stopRef: string, fromWeek: string) {
  const isStopPlace = stopRef.startsWith("NSR:StopPlace:");
  const stopFilter = isStopPlace
    ? `jsw.stop_ref IN (SELECT stop_ref FROM stop_coords WHERE stop_place_ref = ?)`
    : `jsw.stop_ref = ?`;
  return sqlite.prepare(`
    SELECT
      jsw.line_ref AS lineRef,
      ROUND(SUM(jsw.avg_delay_min * jsw.num_samples) * 1.0 / SUM(jsw.num_samples), 2) AS avgDelayMin,
      SUM(jsw.num_samples) AS numSamples
    FROM journey_stop_weekly jsw
    WHERE ${stopFilter} AND jsw.week_start >= ?
    GROUP BY jsw.line_ref
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
        ? and(gte(schema.lineDaily.date, fromDate), eq(schema.lineDaily.vehicleMode, "bus"), like(schema.lineDaily.lineRef, `${operator}:%`))
        : and(gte(schema.lineDaily.date, fromDate), eq(schema.lineDaily.vehicleMode, "bus")),
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
        eq(schema.stopDaily.vehicleMode, "bus"),
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

export async function getWorstDays(limit = 10, operator = "SKY") {
  return db
    .select()
    .from(schema.worstDays)
    .where(eq(schema.worstDays.operator, operator))
    .orderBy(desc(schema.worstDays.avgDelayMin))
    .limit(limit)
    .all();
}

export async function getBestDays(limit = 10, operator = "SKY") {
  return db
    .select()
    .from(schema.dailySummary)
    .where(eq(schema.dailySummary.operator, operator))
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
        jsw.stop_ref AS stopRef,
        COALESCE(MAX(sc.stop_name), jsw.stop_ref) AS stopName,
        ROUND(SUM(jsw.avg_delay_min * jsw.num_samples) * 1.0
              / NULLIF(SUM(jsw.num_samples), 0), 2) AS avgDelayMin,
        ROUND(SUM(CASE WHEN jsw.avg_delay_arrival_min IS NOT NULL
              THEN jsw.avg_delay_arrival_min * jsw.num_samples ELSE 0 END) * 1.0
              / NULLIF(SUM(CASE WHEN jsw.avg_delay_arrival_min IS NOT NULL
              THEN jsw.num_samples ELSE 0 END), 0), 2) AS avgDelayArrivalMin,
        ROUND(SUM(CASE WHEN jsw.avg_delay_departure_min IS NOT NULL
              THEN jsw.avg_delay_departure_min * jsw.num_samples ELSE 0 END) * 1.0
              / NULLIF(SUM(CASE WHEN jsw.avg_delay_departure_min IS NOT NULL
              THEN jsw.num_samples ELSE 0 END), 0), 2) AS avgDelayDepartureMin,
        ROUND(SUM(CASE WHEN jsw.avg_dwell_time_sec IS NOT NULL
              THEN jsw.avg_dwell_time_sec * jsw.num_samples ELSE 0 END) * 1.0
              / NULLIF(SUM(CASE WHEN jsw.avg_dwell_time_sec IS NOT NULL
              THEN jsw.num_samples ELSE 0 END), 0), 1) AS avgDwellTimeSec,
        SUM(jsw.num_samples) AS numSamples
      FROM journey_stop_weekly jsw
      LEFT JOIN stop_coords sc ON sc.stop_ref = jsw.stop_ref
      WHERE jsw.line_ref = ? AND jsw.week_start >= ?
        AND jsw.stop_ref IN (${placeholders})
      GROUP BY jsw.stop_ref
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
 * Look up historical delay stats from journey_stop_weekly for a list of
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
  // journey_stop_weekly has a 13-week rolling window — aggregate across all weeks.
  const conditions = stops
    .map(() => `(jsw.stop_ref = ? AND jsw.line_ref = ?)`)
    .join(" OR ");
  const params = stops.flatMap((s) => [s.stopRef, s.lineRef]);

  const rows = sqlite.prepare(`
    SELECT
      jsw.stop_ref AS stopRef,
      jsw.line_ref AS lineRef,
      ROUND(SUM(jsw.avg_delay_min * jsw.num_samples) * 1.0 / SUM(jsw.num_samples), 2) AS avgDelayMin,
      ROUND(SUM(CASE WHEN jsw.avg_delay_arrival_min IS NOT NULL
                     THEN jsw.avg_delay_arrival_min * jsw.num_samples ELSE 0 END) * 1.0
            / NULLIF(SUM(CASE WHEN jsw.avg_delay_arrival_min IS NOT NULL
                              THEN jsw.num_samples ELSE 0 END), 0), 2) AS avgDelayArrivalMin,
      ROUND(SUM(CASE WHEN jsw.avg_delay_departure_min IS NOT NULL
                     THEN jsw.avg_delay_departure_min * jsw.num_samples ELSE 0 END) * 1.0
            / NULLIF(SUM(CASE WHEN jsw.avg_delay_departure_min IS NOT NULL
                              THEN jsw.num_samples ELSE 0 END), 0), 2) AS avgDelayDepartureMin,
      ROUND(SUM(CASE WHEN jsw.avg_dwell_time_sec IS NOT NULL
                     THEN jsw.avg_dwell_time_sec * jsw.num_samples ELSE 0 END) * 1.0
            / NULLIF(SUM(CASE WHEN jsw.avg_dwell_time_sec IS NOT NULL
                              THEN jsw.num_samples ELSE 0 END), 0), 1) AS avgDwellTimeSec,
      SUM(jsw.num_samples) AS numSamples
    FROM journey_stop_weekly jsw
    WHERE (${conditions})
    GROUP BY jsw.stop_ref, jsw.line_ref
  `).all(...params) as any;

  return rows;
}
