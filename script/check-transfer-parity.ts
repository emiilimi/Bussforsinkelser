// Paritetssjekk for overgangsfilene — kjøres av pipeline/check_transfer_parity.py.
//   sql     <work> <transferDir>  specs.json → sql.json (klientens egen SQL)
//   compare <work> <transferDir>  duck.json + filene → rapport, exit 1 ved avvik
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  transferGapSql, gapResultFromRows, probFromGaps, statsWindowSql,
  type TransferSpec, type CombinedGapRow,
} from "../client/src/lib/trip-shared";
import { localTransferGapRows, localDelayDistribution, localLegTiming } from "../client/src/lib/transfer-data";

const [mode, work, transferDir] = process.argv.slice(2);
const specs: TransferSpec[] = JSON.parse(readFileSync(join(work, "specs.json"), "utf8"));

function pairsOf(s: TransferSpec) {
  return [
    { stopRef: s.arrQuayRef!, lineRef: s.arrLineRef! },
    { stopRef: s.depQuayRef!, lineRef: s.depLineRef! },
  ];
}

/** Samme SQL som useTripDelayDistribution i trip-planner.tsx. */
function distSql(s: TransferSpec): string {
  const cond = pairsOf(s).map((p) => `(stop_ref = '${p.stopRef}' AND line_ref = '${p.lineRef}')`).join(" OR ");
  return `
    SELECT stop_ref, line_ref,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_departure_min) AS p50_dep,
      PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_departure_min) AS p80_dep,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_departure_min) AS p95_dep,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_arrival_min) AS p50_arr,
      PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_arrival_min) AS p80_arr,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delay_arrival_min) AS p95_arr,
      COUNT(*) AS n
    FROM delays_by_stop
    WHERE (${cond}) ${statsWindowSql(s.statsWindow!)}
      AND (delay_departure_min IS NOT NULL OR delay_arrival_min IS NOT NULL)
    GROUP BY stop_ref, line_ref`;
}

/** Kopi av legTimingSql i trip-planner.tsx (ankomstsiden av overgangen). */
function legSql(s: TransferSpec, delta?: number): string {
  const win = statsWindowSql(s.statsWindow!);
  const hour = Math.floor(s.arrAimedMin! / 60);
  const where = delta != null
    ? `line_ref = '${s.arrLineRef}' AND stop_ref = '${s.arrQuayRef}' ${win}
       AND CAST(SUBSTR(aimed_arrival, 1, 2) AS INTEGER) BETWEEN ${hour - delta} AND ${hour + delta}`
    : `service_journey_id = '${s.arrSjId}' AND stop_ref = '${s.arrQuayRef}' ${win}`;
  return `SELECT PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delay_arrival_min) AS p50,
                 PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY delay_arrival_min) AS p80, COUNT(*) AS n
          FROM delays_by_stop WHERE ${where} AND delay_arrival_min IS NOT NULL`;
}

if (mode === "sql") {
  writeFileSync(join(work, "sql.json"), JSON.stringify(
    specs.map((s) => ({ key: s.key, sql: transferGapSql(s), distSql: distSql(s),
                        winSql: statsWindowSql(s.statsWindow!),
                        legSql: [legSql(s), legSql(s, 1), legSql(s, 2)] }))));
  process.exit(0);
}

// --- compare: fetch leser filene fra disk i stedet for R2 -------------------
(globalThis as any).fetch = async (url: string) => {
  const rel = String(url).split("/transfer/")[1]?.split("?")[0];
  try {
    const body = readFileSync(join(transferDir, rel), "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => null };
  }
};

const duck: Record<string, { rows: CombinedGapRow[]; dist: any[][]; ties: string[]; leg: any[][] }> =
  JSON.parse(readFileSync(join(work, "duck.json"), "utf8"));

const close = (a: number | null, b: number | null, tol = 0.011) =>
  (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= tol);
const sorted = (x: number[]) => [...x].sort((a, b) => a - b);

let gapOk = 0, distOk = 0, distPairs = 0, legOk = 0, legN = 0;
const problems: string[] = [];
let withData = 0;
let ambiguousSpecs = 0;
let tiedRows = 0;
const sources: Record<string, number> = {};

for (const s of specs) {
  const local = await localDelayDistribution(pairsOf(s), s.statsWindow!, null);
  const dmap = new Map(duck[s.key].dist.map((r) => [`${r[0]}|${r[1]}`, r]));
  for (const p of pairsOf(s)) {
    distPairs++;
    const k = `${p.stopRef}|${p.lineRef}`;
    const l = local?.get(k), d = dmap.get(k);
    if (!l && !d) { distOk++; continue; }
    const ok = !!l && !!d && l.n === Number(d[8]) &&
      close(l.p50_dep, d[2]) && close(l.p80_dep, d[3]) && close(l.p95_dep, d[4]) &&
      close(l.p50_arr, d[5]) && close(l.p80_arr, d[6]) && close(l.p95_arr, d[7]);
    if (ok) distOk++;
    else problems.push(`${s.key} persentil ${k}: lokal ${JSON.stringify(l && [l.n, l.p50_dep, l.p80_dep, l.p50_arr, l.p80_arr])} ≠ duck ${JSON.stringify(d && [d[8], d[2], d[3], d[5], d[6]])}`);
  }
  // Estimert ankomst per legg: samme avgang, ±1 t, ±2 t (legTimingSql)
  for (const [i, delta] of [undefined, 1, 2].entries()) {
    legN++;
    const l = await localLegTiming({ serviceJourneyId: s.arrSjId!, quayRef: s.arrQuayRef!, lineRef: s.arrLineRef!,
      kind: "arr", aimedHour: Math.floor(s.arrAimedMin! / 60), window: s.statsWindow! }, delta, null);
    const d = duck[s.key].leg[i];
    if (l && l.n === Number(d[2]) && close(l.p50, d[0]) && close(l.p80, d[1])) legOk++;
    else problems.push(`${s.key} legg ${delta ?? "sj"}: lokal ${JSON.stringify(l)} ≠ duck ${JSON.stringify(d)}`);
  }
  const rows = await localTransferGapRows(s, null);
  if (!rows) { problems.push(`${s.key}: filene dekket ikke overgangen`); continue; }
  const L = gapResultFromRows(rows);
  const D = gapResultFromRows(duck[s.key].rows);
  sources[D.source] = (sources[D.source] ?? 0) + 1;
  if (D.gaps.length > 0) withData++;
  const issues: string[] = [];

  // 1) Rådata: ALLE rader (før «første rad per dato») må være like. Det er
  //    det strengeste kravet, og det eneste som er entydig: har to avganger
  //    samme rutetid, gir DuckDB radene i vilkårlig rekkefølge, og da kan
  //    utvalget under variere fra kjøring til kjøring også i DuckDB selv.
  // Nivå 3 på datoer der to avganger er like nær planlagt tid: DuckDB velger
  // vilkårlig (se nearestPerDate i transfer-data.ts) — bare datoen sammenlignes.
  const ties = new Set(duck[s.key].ties);
  const sig = (r: CombinedGapRow[]) =>
    r.map((x) => {
      const d = String(x.date).slice(0, 10);
      const tie = x.src === "P" && ties.has(d);
      if (tie) tiedRows++;
      return { k: `${x.src}|${d}`, g: tie ? 0 : Number(x.gap) };
    })
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.g - b.g));
  const ls = sig(rows), ds = sig(duck[s.key].rows);
  if (ls.length !== ds.length || ls.some((v, i) => v.k !== ds[i].k || !close(v.g, ds[i].g, 0.02))) {
    problems.push(`${s.key}: rådata ulik (${ls.length} mot ${ds.length} rader)`);
    continue;
  }
  const ambiguous = new Set<string>();
  const seen = new Set<string>();
  for (const r of duck[s.key].rows) {
    const k = `${r.src}|${String(r.date).slice(0, 10)}`;
    if (seen.has(k)) ambiguous.add(k);
    seen.add(k);
  }
  const tiedHere = duck[s.key].rows.some((r) => r.src === "P" && ties.has(String(r.date).slice(0, 10)));
  if (ambiguous.size > 0 || (tiedHere && D.source === "pool")) {
    // Rådata er like (sjekket over); bare DuckDBs vilkårlige valg skiller.
    ambiguousSpecs++; gapOk++; continue;
  }
  if (L.source !== D.source) issues.push(`kilde ${L.source} ≠ ${D.source}`);
  if (L.actual.days !== D.actual.days) issues.push(`egne dager ${L.actual.days} ≠ ${D.actual.days}`);
  if (L.pool.days !== D.pool.days) issues.push(`pool-dager ${L.pool.days} ≠ ${D.pool.days}`);
  const lg = sorted(L.gaps), dg = sorted(D.gaps);
  if (lg.length !== dg.length || lg.some((g, i) => !close(g, dg[i], 0.02))) issues.push(`gap ${lg.slice(0, 5)} ≠ ${dg.slice(0, 5)}`);
  for (const buf of [0, 1, 2, 3, 5]) {
    const lp = probFromGaps(L.gaps, buf), dp = probFromGaps(D.gaps, buf);
    if (Math.abs(lp - dp) > 1e-9) { issues.push(`P(buffer ${buf}) ${lp.toFixed(3)} ≠ ${dp.toFixed(3)}`); break; }
  }
  if (issues.length) problems.push(`${s.key}: ${issues.join("; ")}`);
  else gapOk++;

}

console.log(`Overganger: ${gapOk}/${specs.length} like (${withData} med data; kilde i DuckDB: ${JSON.stringify(sources)})`);
console.log(`  herav ${ambiguousSpecs} der DuckDB velger vilkårlig (lik rutetid / uavgjort nabo) — rådata like, sluttsvaret ikke sammenlignbart`);
console.log(`  ${tiedRows / 2} nivå 3-rader på uavgjorte datoer (to naboavganger like nær) — kun datoen sammenlignet`);
console.log(`Persentiler: ${distOk}/${distPairs} (stopp, linje)-par like`);
console.log(`Estimert ankomst: ${legOk}/${legN} like (samme avgang, ±1 t, ±2 t)`);
for (const p of problems.slice(0, 25)) console.log("  ✗", p);
process.exit(problems.length ? 1 : 0);
