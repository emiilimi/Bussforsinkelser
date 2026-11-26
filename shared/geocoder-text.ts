// ---------------------------------------------------------------------------
// Hjelpere for stoppsøket (Entur Geocoder), delt av Express-serveren og
// Cloudflare-workeren (functions/api/geocoder/autocomplete.ts).
// ---------------------------------------------------------------------------

/**
 * Hverdagsord → det NSR faktisk kaller stedet. Brukes BARE når Entur gir null
 * treff på det brukeren skrev. «Stavanger busstasjon» ga ingenting fordi
 * stedet heter «Stavanger bussterminal» (brukertest 2026-11-25), og
 * «Bergen busstasjon» heter nettopp busstasjon — så det går begge veier.
 */
// Bussterminalen heter noe ulikt fra by til by: Bergen busstasjon, Stavanger
// bussterminal, Førde rutebilstasjon, Gjøvik skysstasjon, Molde
// trafikkterminal. «Ålesund rutebilstasjon» finnes ikke under NOEN av dem
// (brukertest 2026-11-26) — da er stedsnavnet alene det beste vi kan gi.
const BUS_WORDS = ["bussterminal", "busstasjon", "rutebilstasjon", "skysstasjon", "trafikkterminal"];
const BUS_RE = /\b(busstasjon|bussterminal|rutebilstasjon|skysstasjon|trafikkterminal)(en)?\b/i;

const SYNONYMS: Array<[RegExp, string]> = [
  [/\b(jernbane|tog)stasjon(en)?\b/i, "stasjon"],
  [/\bflyplass(en)?\b/i, "lufthavn"],
  [/\bflyterminal(en)?\b/i, "lufthavn"],
  [/\bferjekai(a|en)?\b/i, "ferjekai"],
];

type Fallback = { text: string; mustContain?: string };

/**
 * Alternative søketekster, i prioritert rekkefølge, når originalen ga null
 * treff. `mustContain`: treffets NAVN må inneholde stedsnavnet — ellers gir
 * «Ålesund trafikkterminal» Moa trafikkterminal (Ålesund kommune, 7 km fra
 * sentrum) fordi Entur også matcher på kommunen.
 */
export function geocoderFallbacks(text: string): Fallback[] {
  const out: Fallback[] = [];
  const add = (s: string, mustContain?: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length >= 2 && t.toLowerCase() !== text.toLowerCase() && !out.some((o) => o.text.toLowerCase() === t.toLowerCase())) {
      out.push({ text: t, mustContain });
    }
  };
  const bus = text.match(BUS_RE);
  if (bus) {
    const place = text.replace(BUS_RE, "").replace(/\s+/g, " ").trim().toLowerCase();
    for (const w of BUS_WORDS) add(text.replace(BUS_RE, w), place || undefined);
    add(place); // «Ålesund rutebilstasjon» → «Ålesund»
  }
  for (const [re, to] of SYNONYMS) {
    if (re.test(text)) add(text.replace(re, to));
  }
  return out;
}

/** Prøv alternativene parallelt; første (i prioritert rekkefølge) med treff vinner. */
export async function firstFallbackHit<T extends { properties?: { name?: string } }>(
  text: string,
  query: (t: string) => Promise<T[] | null>,
): Promise<T[]> {
  const alts = geocoderFallbacks(text);
  if (!alts.length) return [];
  const all = await Promise.all(alts.map((a) => query(a.text).catch(() => null)));
  for (let i = 0; i < alts.length; i++) {
    const m = alts[i].mustContain;
    const hits = (all[i] ?? []).filter((f) => !m || (f.properties?.name ?? "").toLowerCase().includes(m));
    if (hits.length) return hits;
  }
  return [];
}

type GeoFeature = { properties?: { id?: string; name?: string; label?: string } };

/**
 * «Oslo sentrum», «Stavanger sentrum», «Tromsø sentrum» fant tannlegevakter,
 * politistasjoner, Gausel sentrum og Førde sentrum i Sveio — ikke byen
 * (brukertest runde 7). Bynavnet alene gir derimot NSR sin stoppestedsgruppe
 * for byen (NSR:GroupOfStopPlaces, punkt midt i sentrum). Legg den øverst når
 * ingen treff faktisk HETER «<by> sentrum…» (Bodø sentrum og Sandnes sentrum
 * stasjon finnes og beholdes).
 */
export async function withCityCentre<T extends GeoFeature>(
  text: string,
  features: T[],
  query: (t: string) => Promise<T[] | null>,
): Promise<T[]> {
  const m = text.trim().match(/^(.+?)\s+sentrum$/i);
  if (!m) return features;
  const place = m[1].trim().toLowerCase();
  // Bare STOPPESTEDER teller — «Trondheim sentrum politistasjon» gjør ikke.
  // (NSR-gruppen «Bergen sentrum» gjør.)
  const has = features.some((f) => /^NSR:(StopPlace|GroupOfStopPlaces):/.test(f.properties?.id ?? "")
    && (f.properties?.name ?? "").toLowerCase().startsWith(`${place} sentrum`));
  if (has) return features;
  const city = ((await query(m[1]).catch(() => null)) ?? []).find((f) =>
    (f.properties?.id ?? "").startsWith("NSR:GroupOfStopPlaces:")
    && (f.properties?.name ?? "").toLowerCase() === place);
  if (!city) return features;
  return [city, ...features.filter((f) => f.properties?.id !== city.properties?.id)];
}

/**
 * Fjern treff som ser identiske ut for brukeren (samme navn, etikett og
 * type) — «Apotek 1 Lagunen» kom to ganger med ulik OSM-id. Stoppesteder
 * (venue) beholdes alltid: to stopp med samme navn i samme kommune finnes.
 */
export function dedupeGeocoder<T extends { label?: string; name?: string; layer?: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (r.layer === "venue") return true;
    const k = `${r.layer}|${r.label ?? r.name}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
