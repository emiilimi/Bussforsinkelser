// ---------------------------------------------------------------------------
// Disambiguering av navneduplikater i stoppsøk (Entur-geocoderet).
//
// Norge har flere fysisk urelaterte stoppesteder med identisk navn — f.eks.
// "Kringsjå" finnes i Oslo, Bergen, Fredrikstad og Vennesla (bekreftet via
// Enturs geocoder 2026-08-14, se STATUS.md samme dato). Uten disambiguering
// er det umulig å se i søkeresultatet hvilket faktiske sted man velger.
// ---------------------------------------------------------------------------

import { operatorDisplayName } from "@/lib/RegionContext";

export type DisambiguatableStop = {
  stopName: string | null;
  locality?: string | null;
  operatorHint?: string | null;
};

function normName(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Parentes-suffiks for ett treff, KUN når navnet forekommer flere ganger i
 * samme resultatsett `all` — enkeltnavn (det vanlige) forblir uendret.
 *
 * Format, beste tilgjengelige først: "By, Operatør" → "By" → "Operatør" →
 * null (ingen suffiks, om verken by eller operatør er kjent).
 *
 * Kjent begrensning: to stoppesteder med samme navn i SAMME kommune (og
 * samme operatør) kan ikke skilles med det geocoderet gir for venue-treff —
 * bydel/gate følger kun med på adresse-treff, ikke stoppested-treff.
 */
export function disambiguationSuffix<T extends DisambiguatableStop>(
  all: readonly T[],
  entry: T,
): string | null {
  const name = normName(entry.stopName);
  if (!name) return null;
  const dupes = all.filter((s) => normName(s.stopName) === name);
  if (dupes.length < 2) return null;

  const locality = entry.locality?.trim() || null;
  const operator = operatorDisplayName(entry.operatorHint);
  if (locality && operator) return `${locality}, ${operator}`;
  if (locality) return locality;
  if (operator) return operator;
  return null;
}

/** `name` med disambiguerende parentes vedheftet, om noen. */
export function disambiguatedName<T extends DisambiguatableStop>(
  all: readonly T[],
  entry: T,
  name: string,
): string {
  const suffix = disambiguationSuffix(all, entry);
  return suffix ? `${name} (${suffix})` : name;
}
