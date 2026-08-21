// ---------------------------------------------------------------------------
// Nylige søk, favoritter og «Min posisjon» for reiseplanleggeren.
//
// Lagring: localStorage. Ingen innlogging, ingen server, ingen cookies — dette
// er førsteparts *funksjonell* lagring (brukerens egne valg på egen maskin),
// ikke sporing, så det utløser heller ikke krav om samtykkebanner. Samme
// mekanisme som regionvalget allerede bruker (lib/RegionContext.tsx).
//
// Alt er defensivt mot at localStorage kan være utilgjengelig (privat modus,
// blokkert av nettleserinnstillinger) — da degraderes funksjonen stille til
// «ingen historikk» i stedet for å kaste.
// ---------------------------------------------------------------------------

import type { StopSearchResult } from "@/lib/trip-shared";

const RECENT_KEY = "sentur_recent_stops";
const FAVORITE_KEY = "sentur_favorite_stops";
const MAX_RECENT = 8;

function read(key: string): StopSearchResult[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filtrer bort ødelagte/gamle oppføringer så UI-et aldri krasjer på dem.
    return parsed.filter(
      (s): s is StopSearchResult =>
        s && typeof s.stopRef === "string" && typeof s.stopName === "string",
    );
  } catch {
    return [];
  }
}

function write(key: string, items: StopSearchResult[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    /* full disk / privat modus — ignorér, funksjonen er valgfri */
  }
}

/** Nylig valgte steder, nyeste først. */
export function getRecentStops(): StopSearchResult[] {
  return read(RECENT_KEY);
}

/**
 * Legg et valgt sted øverst i historikken (dedupliserer på stopRef).
 * «Min posisjon» lagres IKKE: koordinaten er ferskvare og ville pekt på der du
 * var forrige gang, ikke der du er nå.
 */
export function addRecentStop(stop: StopSearchResult): void {
  if (stop.layer === "position") return;
  const next = [stop, ...read(RECENT_KEY).filter((s) => s.stopRef !== stop.stopRef)];
  write(RECENT_KEY, next.slice(0, MAX_RECENT));
}

export function getFavoriteStops(): StopSearchResult[] {
  return read(FAVORITE_KEY);
}

export function isFavorite(stopRef: string): boolean {
  return read(FAVORITE_KEY).some((s) => s.stopRef === stopRef);
}

/** Slå favoritt av/på. Returnerer den nye lista. */
export function toggleFavorite(stop: StopSearchResult): StopSearchResult[] {
  const current = read(FAVORITE_KEY);
  const exists = current.some((s) => s.stopRef === stop.stopRef);
  const next = exists
    ? current.filter((s) => s.stopRef !== stop.stopRef)
    : [...current, stop];
  write(FAVORITE_KEY, next);
  return next;
}

// ---------------------------------------------------------------------------
// Min posisjon (Geolocation API)
// ---------------------------------------------------------------------------

/** Feiltekster på norsk — Geolocation-API-ets egne meldinger er engelske. */
export function geolocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Du har ikke gitt tilgang til posisjon. Tillat posisjon i nettleseren og prøv igjen.";
    case err.POSITION_UNAVAILABLE:
      return "Fant ikke posisjonen din akkurat nå. Prøv igjen, eller søk opp stoppestedet.";
    case err.TIMEOUT:
      return "Det tok for lang tid å finne posisjonen din. Prøv igjen.";
    default:
      return "Kunne ikke hente posisjonen din.";
  }
}

/**
 * Slår opp koordinatet mot Enturs reverse-geocoder for å finne det generelle
 * området posisjonen ble tolket til å være i (f.eks. «Vaskerelven, Bergen»).
 * Brukes til å vise brukeren HVOR "Min posisjon" traff, slik at en unøyaktig
 * posisjon (feil bydel, feil by) er synlig med det samme i selve feltteksten
 * i stedet for at "Min posisjon" bare vises som en opak etikett man må stole
 * blindt på. Serveren generaliserer allerede bort spesifikke adresser/POI-navn
 * (se generalAreaLabel i server/routes.ts / functions/api/geocoder/reverse.ts).
 * Feiler stille (returnerer null) — reverse-oppslaget er en bonus, ikke en
 * forutsetning for at "Min posisjon" skal fungere.
 */
async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(`/api/geocoder/reverse?lat=${lat}&lng=${lng}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.label ?? null;
  } catch {
    return null;
  }
}

/**
 * Sist kjente posisjon i denne fanen, satt av getCurrentPositionAsStop().
 *
 * Brukes som geografisk fokuspunkt i stoppesøket. Bevisst kun i minnet og kun
 * etter at brukeren selv har trykt «Min posisjon» — søket skal aldri utløse en
 * posisjonsforespørsel på egen hånd.
 */
let lastKnownPosition: { lat: number; lng: number } | null = null;

export function getLastKnownPosition(): { lat: number; lng: number } | null {
  return lastKnownPosition;
}

/**
 * Hent nåværende posisjon som et StopSearchResult.
 *
 * Krever HTTPS (sentur.no har det) og at brukeren godkjenner. Resultatet får
 * `layer: "position"` slik at det holdes utenfor søkehistorikken. `stopName`
 * blir «Min posisjon (området)» når reverse-oppslaget lykkes, slik at selve
 * søkefeltet viser hvor posisjonen traff — ikke bare den opake teksten
 * «Min posisjon».
 */
export function getCurrentPositionAsStop(): Promise<StopSearchResult> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Nettleseren din støtter ikke posisjonstjenester."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        lastKnownPosition = { lat: latitude, lng: longitude };
        const resolvedArea = await reverseGeocode(latitude, longitude);
        const stopName = resolvedArea ? `Min posisjon (${resolvedArea})` : "Min posisjon";
        resolve({
          stopRef: `coords:${latitude},${longitude}`,
          stopPlaceRef: null,
          stopName,
          label: stopName,
          layer: "position",
          lat: latitude,
          lng: longitude,
        });
      },
      (err) => reject(new Error(geolocationErrorMessage(err))),
      // Litt slingringsmonn: en fersk, presis fix er ikke verdt å vente evig på
      // når brukeren bare skal finne nærmeste holdeplass.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}
