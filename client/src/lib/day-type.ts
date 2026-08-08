// Day-type classification mirroring pipeline/day_type.py.
// Priority order (highest first): may17 → holiday → sunday → saturday → weekday.
//
// Norwegian movable feasts are pre-computed for years that overlap with our
// 90-day Parquet window. Add new years before the existing window expires.
// Fixed holidays (1 jan, 1 mai, 25/26 dec) are checked separately so they
// keep working in any year — only the Easter-based ones need a date table.

const FIXED_HOLIDAYS_MMDD: ReadonlySet<string> = new Set([
  "01-01", // Nyttårsdag
  "05-01", // Arbeidernes dag
  "12-25", // 1. juledag
  "12-26", // 2. juledag
]);

// Easter-based + Ascension + Pentecost. ISO yyyy-mm-dd.
// 17. mai handles itself via the may17 branch.
const MOVABLE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2024
  "2024-03-28", "2024-03-29", "2024-03-31", "2024-04-01",
  "2024-05-09", "2024-05-19", "2024-05-20",
  // 2025
  "2025-04-17", "2025-04-18", "2025-04-20", "2025-04-21",
  "2025-05-29", "2025-06-08", "2025-06-09",
  // 2026
  "2026-04-02", "2026-04-03", "2026-04-05", "2026-04-06",
  "2026-05-14", "2026-05-24", "2026-05-25",
  // 2027
  "2027-03-25", "2027-03-26", "2027-03-28", "2027-03-29",
  "2027-05-06", "2027-05-16", "2027-05-17",
  // 2028
  "2028-04-13", "2028-04-14", "2028-04-16", "2028-04-17",
  "2028-05-25", "2028-06-04", "2028-06-05",
]);

export type DayType = "weekday" | "saturday" | "sunday" | "holiday" | "may17";

/** Norske etiketter for visning i UI. */
export const DAY_TYPE_LABELS: Record<DayType, string> = {
  weekday: "ukedag",
  saturday: "lørdag",
  sunday: "søndag",
  holiday: "helligdag",
  may17: "17. mai",
};

/** Compute Norwegian transit day_type from an ISO date string (YYYY-MM-DD),
 *  a full ISO timestamp, or a Date. Logic must match pipeline/day_type.py
 *  exactly so that client-side filters hit the same buckets the ingest
 *  produced.
 *
 *  MERK: tidligere gjorde denne `new Date(input + "T12:00:00")` uansett
 *  input-form. For et fullt tidsstempel (som Enturs `expectedStartTime`,
 *  «2026-08-08T08:00:00+02:00») ga det «...+02:00T12:00:00» → Invalid Date →
 *  alle felt NaN → funksjonen falt gjennom til «weekday». Alle kallene i
 *  reiseplanleggeren sender nettopp fullt tidsstempel, så lørdags-, søndags-
 *  og 17. mai-reiser ble stille filtrert mot UKEDAGS-statistikk. Derfor
 *  skiller vi nå på ren dato og tidsstempel. */
export function computeDayType(input: string | Date): DayType {
  const d =
    typeof input === "string"
      ? /^\d{4}-\d{2}-\d{2}$/.test(input)
        // Ren dato: midt på dagen LOKALT, så tidssone aldri flytter kalenderdagen.
        ? new Date(`${input}T12:00:00`)
        // Fullt tidsstempel: la Date tolke det som det er.
        : new Date(input)
      : input;
  // Uparsebar input skal ikke stille bli «weekday» — det var nettopp den
  // stille fallbacken som skjulte feilen over.
  if (Number.isNaN(d.getTime())) {
    throw new Error(`computeDayType: kunne ikke tolke datoen «${String(input)}»`);
  }
  const month = d.getMonth() + 1;
  const day = d.getDate();
  if (month === 5 && day === 17) return "may17";
  const iso = `${d.getFullYear()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const mmdd = iso.slice(5);
  if (FIXED_HOLIDAYS_MMDD.has(mmdd) || MOVABLE_HOLIDAYS.has(iso)) return "holiday";
  const weekday = d.getDay(); // 0 = søndag … 6 = lørdag
  if (weekday === 6) return "saturday";
  if (weekday === 0) return "sunday";
  return "weekday";
}
