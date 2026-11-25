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
const SYNONYMS: Array<[RegExp, string]> = [
  [/\bbusstasjon(en)?\b/i, "bussterminal"],
  [/\bbussterminal(en)?\b/i, "busstasjon"],
  [/\b(jernbane|tog)stasjon(en)?\b/i, "stasjon"],
  [/\bflyplass(en)?\b/i, "lufthavn"],
  [/\bflyterminal(en)?\b/i, "lufthavn"],
  [/\bferjekai(a|en)?\b/i, "ferjekai"],
];

/** Alternativ søketekst når originalen ga null treff, eller null. */
export function geocoderFallbackText(text: string): string | null {
  for (const [re, to] of SYNONYMS) {
    if (re.test(text)) {
      const alt = text.replace(re, to);
      if (alt.toLowerCase() !== text.toLowerCase()) return alt;
    }
  }
  return null;
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
