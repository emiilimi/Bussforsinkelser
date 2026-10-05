/**
 * Norwegian date formatting utilities for charts and UI.
 */

const MONTHS_NO = [
  "januar", "februar", "mars", "april", "mai", "juni",
  "juli", "august", "september", "oktober", "november", "desember",
];

const MONTHS_SHORT_NO = [
  "jan", "feb", "mar", "apr", "mai", "jun",
  "jul", "aug", "sep", "okt", "nov", "des",
];

const WEEKDAYS_NO = [
  "søndag", "mandag", "tirsdag", "onsdag",
  "torsdag", "fredag", "lørdag",
];

const WEEKDAYS_SHORT_NO = [
  "søn", "man", "tir", "ons", "tor", "fre", "lør",
];

/**
 * "2026-03-19" → "19. mars"
 */
export function formatDateNO(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return `${d.getDate()}. ${MONTHS_NO[d.getMonth()]}`;
}

/**
 * "2026-03-19" → "19. mar"
 */
export function formatDateShortNO(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return `${d.getDate()}. ${MONTHS_SHORT_NO[d.getMonth()]}`;
}

/**
 * "2026-03-19" → "onsdag"
 */
export function formatWeekdayNO(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return WEEKDAYS_NO[d.getDay()];
}

/**
 * "2026-03-19" → "ons"
 */
export function formatWeekdayShortNO(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return WEEKDAYS_SHORT_NO[d.getDay()];
}

/**
 * "2026-03-19" → "ons 19."
 */
export function formatWeekdayDateNO(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return `${WEEKDAYS_SHORT_NO[d.getDay()]} ${d.getDate()}.`;
}

/**
 * "2026-03-19" → "Uke 12"
 */
export function formatWeekNO(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  // ISO week number
  const temp = new Date(d.getTime());
  temp.setDate(temp.getDate() + 3 - ((temp.getDay() + 6) % 7));
  const week1 = new Date(temp.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((temp.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `Uke ${weekNum}`;
}

/**
 * "2026-03-19" → "Mars"
 */
export function formatMonthNO(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  const name = MONTHS_NO[d.getMonth()];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Extract line number from line_ref: "SKY:Line:60" → "60"
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_NAME_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:?\s*/gi;

export function lineNumber(lineRef: string): string {
  const parts = lineRef.split(":");
  const last = parts.length >= 3 ? parts[parts.length - 1] : lineRef;
  // Flixbus (FLI) m.fl. bruker en UUID som linje-id — «0a73c829-ebbd-…» er
  // verken lesbart eller et linjenummer. Vis operatørkoden i stedet.
  return UUID_RE.test(last) ? parts[0] : last;
}

/**
 * Togoperatører. En linje fra disse med vehicle_mode=bus er buss for tog
 * (målt uke 39 2026: VYG R12 hadde 4 589 rail- og 752 bus-rader — bussene
 * er de samme linjene, kjørt med erstatningsbuss).
 */
const RAIL_OPERATORS = new Set(["VYG", "GOA", "SJN", "FLT", "NSB"]);

export function isRailOperator(lineRef: string): boolean {
  return RAIL_OPERATORS.has(lineRef.split(":")[0]);
}

/** Fjern UUID-er fra linjenavn: «FLI 0a73c829-…: Bergen - Oslo» → «FLI: Bergen - Oslo». Andre navn returneres uendret. */
export function cleanLineName(name: string | null | undefined): string | null {
  if (!name) return name ?? null;
  UUID_IN_NAME_RE.lastIndex = 0;
  if (!UUID_IN_NAME_RE.test(name)) return name;
  UUID_IN_NAME_RE.lastIndex = 0;
  const cleaned = name.replace(UUID_IN_NAME_RE, "").replace(/^([A-ZÆØÅ]{2,4})\s*:?\s*/, "$1: ").trim();
  return cleaned || name;
}
