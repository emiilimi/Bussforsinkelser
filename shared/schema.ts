import { sqliteTable, text, real, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Bus delay tables (populated by Python pipeline)
// ---------------------------------------------------------------------------

export const dailySummary = sqliteTable(
  "daily_summary",
  {
    date: text("date").notNull(),
    // Operator code (e.g. 'SKY', 'RUT') — part of PK for multi-region support.
    operator: text("operator").notNull().default("SKY"),
    avgDelayMin: real("avg_delay_min"),
    pctOnTime: real("pct_on_time"),
    pctDelayed10plus: real("pct_delayed_10plus"),
    totalJourneys: integer("total_journeys"),
    totalCancellations: integer("total_cancellations"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.date, table.operator] }),
  }),
);

export const lineDaily = sqliteTable(
  "line_daily",
  {
    date: text("date").notNull(),
    lineRef: text("line_ref").notNull(),
    // '0' = outbound, '1' = inbound (Entur convention).
    directionRef: text("direction_ref").notNull().default("0"),
    // 'bus', 'tram', 'water', etc. — all modes stored, filtered at query time.
    vehicleMode: text("vehicle_mode").notNull().default("bus"),
    lineName: text("line_name"),
    avgDelayMin: real("avg_delay_min"),
    maxDelayMin: real("max_delay_min"),
    minDelayMin: real("min_delay_min"),
    medianDelayMin: real("median_delay_min"),
    stddevDelayMin: real("stddev_delay_min"),
    pctOnTime: real("pct_on_time"),
    pctDelayed2plus: real("pct_delayed_2plus"),
    pctDelayed10plus: real("pct_delayed_10plus"),
    numDepartures: integer("num_departures"),
    pctRealtimeCoverage: real("pct_realtime_coverage"),
    // NOTE: operator is NOT a separate column — it is embedded in line_ref
    // (e.g. 'SKY:Line:6', 'RUT:Line:31B'). Filter with line_ref LIKE 'SKY:%'.
  },
  (table) => ({
    pk: primaryKey({ columns: [table.date, table.lineRef, table.directionRef, table.vehicleMode] }),
  }),
);

export const stopDaily = sqliteTable(
  "stop_daily",
  {
    date: text("date").notNull(),
    stopRef: text("stop_ref").notNull(),
    // '0' = outbound, '1' = inbound (Entur convention, relative to route).
    directionRef: text("direction_ref").notNull().default("0"),
    // 'bus', 'tram', 'water' — in PK so bus/tram at same stop are separate rows.
    vehicleMode: text("vehicle_mode").notNull().default("bus"),
    // operator IS a separate column: NSR stop refs are operator-agnostic.
    // The same physical stop can be served by both SKY and RUT buses.
    operator: text("operator").notNull().default("SKY"),
    stopName: text("stop_name"),
    avgDelayMin: real("avg_delay_min"),
    maxDelayMin: real("max_delay_min"),
    minDelayMin: real("min_delay_min"),
    stddevDelayMin: real("stddev_delay_min"),
    pctDelayed2plus: real("pct_delayed_2plus"),
    numDepartures: integer("num_departures"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.date, table.stopRef, table.directionRef, table.vehicleMode, table.operator] }),
  }),
);

export const lineHourlyRaw = sqliteTable(
  "line_hourly_raw",
  {
    date: text("date").notNull(),
    lineRef: text("line_ref").notNull(),
    directionRef: text("direction_ref").notNull().default("0"),
    lineName: text("line_name"),
    hour: integer("hour").notNull(),
    avgDelayMin: real("avg_delay_min"),
    numSamples: integer("num_samples"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.date, table.lineRef, table.directionRef, table.hour] }),
  }),
);

export const lineHourlyProfile = sqliteTable(
  "line_hourly_profile",
  {
    lineRef: text("line_ref").notNull(),
    directionRef: text("direction_ref").notNull().default("0"),
    lineName: text("line_name"),
    hour: integer("hour").notNull(),
    avgDelayMin: real("avg_delay_min"),
    // worst/best single-day average for this hour over the 30-day window
    maxAvgDelayMin: real("max_avg_delay_min"),
    minAvgDelayMin: real("min_avg_delay_min"),
    numSamples: integer("num_samples"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lineRef, table.directionRef, table.hour] }),
  }),
);

export const stopHourlyRaw = sqliteTable(
  "stop_hourly_raw",
  {
    date: text("date").notNull(),
    stopRef: text("stop_ref").notNull(),
    hour: integer("hour").notNull(),
    directionRef: text("direction_ref").notNull().default("0"),
    // operator is separate: same NSR stop can be served by multiple operators.
    operator: text("operator").notNull().default("SKY"),
    avgDelayMin: real("avg_delay_min"),
    numSamples: integer("num_samples"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.date, table.stopRef, table.hour, table.directionRef, table.operator] }),
  }),
);

export const stopHourlyProfile = sqliteTable(
  "stop_hourly_profile",
  {
    stopRef: text("stop_ref").notNull(),
    hour: integer("hour").notNull(),
    directionRef: text("direction_ref").notNull().default("0"),
    operator: text("operator").notNull().default("SKY"),
    avgDelayMin: real("avg_delay_min"),
    // worst/best single-day average for this hour over the 30-day window
    maxAvgDelayMin: real("max_avg_delay_min"),
    minAvgDelayMin: real("min_avg_delay_min"),
    numSamples: integer("num_samples"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.stopRef, table.hour, table.directionRef, table.operator] }),
  }),
);

export const leaderboardLines = sqliteTable("leaderboard_lines", {
  lineRef: text("line_ref").primaryKey(),
  lineName: text("line_name"),
  avgDelayMin: real("avg_delay_min"),
  stddevDelayMin: real("stddev_delay_min"),
  pctOnTime: real("pct_on_time"),
  pctDelayed10plus: real("pct_delayed_10plus"),
  totalDepartures: integer("total_departures"),
});

export const worstDays = sqliteTable(
  "worst_days",
  {
    date: text("date").notNull(),
    operator: text("operator").notNull().default("SKY"),
    avgDelayMin: real("avg_delay_min"),
    totalJourneys: integer("total_journeys"),
    totalCancellations: integer("total_cancellations"),
    pctOnTime: real("pct_on_time"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.date, table.operator] }),
  }),
);

export const stopCoords = sqliteTable("stop_coords", {
  stopRef: text("stop_ref").primaryKey(),
  stopName: text("stop_name"),
  lat: real("lat"),
  lng: real("lng"),
  stopPlaceRef: text("stop_place_ref"),
  platformCode: text("platform_code"),
  stopPlaceName: text("stop_place_name"),
});

// Per-journey per-stop weekly aggregates (bus only, 13-week rolling window).
//
// Enables:
//   • Journey profile: delay at each stop along a route (Thomas-analysen)
//   • Worst stop on a line: GROUP BY stop_ref WHERE line_ref = X
//   • Filter stop leaderboard by line
//   • Lines per stop: GROUP BY line_ref WHERE stop_ref = X
export const journeyStopWeekly = sqliteTable(
  "journey_stop_weekly",
  {
    weekStart: text("week_start").notNull(),         // Monday ISO date
    serviceJourneyId: text("service_journey_id").notNull(), // NeTEx ServiceJourney ID
    lineRef: text("line_ref").notNull(),
    directionRef: text("direction_ref").notNull(),
    stopRef: text("stop_ref").notNull(),
    stopSequence: integer("stop_sequence").notNull(), // order along route
    aimedTime: text("aimed_time"),                   // 'HH:MM' local time at this stop
    avgDelayMin: real("avg_delay_min"),
    maxDelayMin: real("max_delay_min"),
    minDelayMin: real("min_delay_min"),
    numSamples: integer("num_samples"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.weekStart, table.serviceJourneyId, table.stopRef] }),
  }),
);

// ---------------------------------------------------------------------------
// TypeScript types inferred from the schema
// ---------------------------------------------------------------------------

export type DailySummary = typeof dailySummary.$inferSelect;
export type LineDaily = typeof lineDaily.$inferSelect;
export type StopDaily = typeof stopDaily.$inferSelect;
export type StopHourlyProfile = typeof stopHourlyProfile.$inferSelect;
export type LineHourlyProfile = typeof lineHourlyProfile.$inferSelect;
export type LeaderboardLine = typeof leaderboardLines.$inferSelect;
export type WorstDay = typeof worstDays.$inferSelect;
export type StopCoord = typeof stopCoords.$inferSelect;
export type JourneyStopWeekly = typeof journeyStopWeekly.$inferSelect;

// Data quality warnings logged during ingest.
// type: 'outlier_delay' (abs(delay_min) > 120) | 'missing_time' (no timing data)
export const dataQualityLog = sqliteTable("data_quality_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  operator: text("operator").notNull().default("SKY"),
  type: text("type").notNull(),
  lineRef: text("line_ref"),
  serviceJourneyId: text("service_journey_id"),
  stopRef: text("stop_ref"),
  aimedTime: text("aimed_time"),
  delayMin: real("delay_min"),
  count: integer("count").default(1),
  total: integer("total"),
  message: text("message").notNull(),
});

export type DataQualityLog = typeof dataQualityLog.$inferSelect;

// ---------------------------------------------------------------------------
// Legacy user table (kept for potential future auth, not used by public site)
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
