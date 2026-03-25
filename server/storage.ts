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
  // One aggregated row per date. When direction is '0' or '1', filter to that direction only.
  // When 'all' or undefined, aggregate both directions (weighted average).
  const baseConditions = and(
    eq(schema.lineDaily.lineRef, lineRef),
    gte(schema.lineDaily.date, fromDate),
    eq(schema.lineDaily.vehicleMode, "bus"),
    direction === "0" || direction === "1"
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
    })
    .from(schema.lineDaily)
    .where(baseConditions)
    .groupBy(schema.lineDaily.date)
    .orderBy(schema.lineDaily.date)
    .all();
}

export async function getLineHourlyProfile(lineRef: string, direction?: string) {
  // When direction is '0' or '1': return that direction's profile row per hour.
  // When 'all' or undefined: aggregate both directions (weighted avg + max/min over both).
  if (direction === "0" || direction === "1") {
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
  return db
    .selectDistinct({
      lineRef: schema.lineDaily.lineRef,
      lineName: schema.lineDaily.lineName,
    })
    .from(schema.lineDaily)
    .where(
      and(
        operator
          ? and(eq(schema.lineDaily.vehicleMode, "bus"), like(schema.lineDaily.lineRef, `${operator}:%`))
          : eq(schema.lineDaily.vehicleMode, "bus"),
        notInArray(schema.lineDaily.lineRef, EXCLUDED_LINE_REFS),
      ),
    )
    .orderBy(schema.lineDaily.lineName)
    .all();
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

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
  return sqlite
    .prepare(
      `SELECT
         jsw.stop_ref        AS stopRef,
         MIN(jsw.stop_sequence) AS stopSequence,
         MAX(jsw.aimed_time) AS aimedTime,
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
       WHERE jsw.service_journey_id IN (
         SELECT service_journey_id
         FROM journey_stop_weekly
         WHERE line_ref = ? AND direction_ref = ?
         GROUP BY service_journey_id
         HAVING MIN(aimed_time) = ?
       )
       GROUP BY jsw.stop_ref
       ORDER BY MIN(jsw.stop_sequence)`,
    )
    .all(lineRef, directionRef, firstStopTime) as any;
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

/** All stops on a line in route order with their average delay.
 *  Unlike getWorstStopsForLine (sorted by delay desc), this preserves the
 *  canonical stop sequence so you can visualise where delay builds up along
 *  the route. direction_ref is required because route order is direction-specific.
 */
export async function getLineStopProfile(
  lineRef: string,
  directionRef: string,
  fromWeek: string,
): Promise<Array<{
  stopRef: string;
  stopSequence: number;
  avgDelayMin: number | null;
  maxDelayMin: number | null;
  minDelayMin: number | null;
  numSamples: number;
  stopName: string | null;
}>> {
  return sqlite.prepare(`
    SELECT
      jsw.stop_ref           AS stopRef,
      MIN(jsw.stop_sequence) AS stopSequence,
      ROUND(SUM(jsw.avg_delay_min * jsw.num_samples) * 1.0
            / NULLIF(SUM(jsw.num_samples), 0), 2)   AS avgDelayMin,
      ROUND(MAX(jsw.max_delay_min), 2)               AS maxDelayMin,
      ROUND(MIN(jsw.min_delay_min), 2)               AS minDelayMin,
      SUM(jsw.num_samples)                           AS numSamples,
      COALESCE(MAX(sc.stop_name), jsw.stop_ref)      AS stopName
    FROM journey_stop_weekly jsw
    LEFT JOIN stop_coords sc ON sc.stop_ref = jsw.stop_ref
    WHERE jsw.line_ref = ? AND jsw.direction_ref = ? AND jsw.week_start >= ?
    GROUP BY jsw.stop_ref
    HAVING SUM(jsw.num_samples) >= 3
    ORDER BY MIN(jsw.stop_sequence)
  `).all(lineRef, directionRef, fromWeek) as any;
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
