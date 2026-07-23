// ---------------------------------------------------------------------------
// Delt hjelpemodul for Entur-proxyen (Cloudflare Pages Functions).
//
// Filnavn med ledende "_" rutes IKKE av Pages — dette er bare en modul de tre
// endepunktene (trip / departures / geocoder) importerer.
//
// Porten av server/routes.ts → Pages Functions. Ingen database, ingen Express;
// bare tilstandsløse proxy-kall til Entur + Cloudflare Cache API for å skåne
// Entur sin rate limit (~30 req/min uregistrert).
// ---------------------------------------------------------------------------

// Entur krever denne headeren på alle kall. Kan overstyres via env (ET_CLIENT_NAME).
export const DEFAULT_ET_CLIENT_NAME = "emiliemoldestad-sentur";

export const JP_V3_URL = "https://api.entur.io/journey-planner/v3/graphql";
export const GEOCODER_URL = "https://api.entur.io/geocoder/v1/autocomplete";

// Minimal kontekst-type så modulen er uavhengig av @cloudflare/workers-types.
// Strukturelt kompatibel med Pages' EventContext.
export interface PagesContext {
  request: Request;
  env: Record<string, string | undefined>;
  params: Record<string, string | string[]>;
  waitUntil(promise: Promise<unknown>): void;
}

export type PagesFunction = (context: PagesContext) => Response | Promise<Response>;

// ---------------------------------------------------------------------------
// GraphQL enum-whitelists — interpoleres direkte inn i GraphQL-dokumentet
// (enums kan ikke sendes som vanlige string-variabler), så de MÅ valideres.
// ---------------------------------------------------------------------------

export const TRANSPORT_MODES = new Set([
  "bus", "tram", "rail", "metro", "water", "coach",
  "air", "cableway", "funicular", "lift", "trolleybus", "monorail",
]);

export const STREET_MODES = new Set([
  "foot", "bicycle", "bike_park", "bike_rental", "scooter_rental",
  "car", "car_park", "car_pickup", "car_rental", "carpool", "flexible",
]);

/** Klem et klient-oppgitt tall til [min, max]; null hvis fraværende/ikke endelig. */
export function clampNumber(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : null;
}

/** Trygt heltall fra en query-parameter (string). */
export function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.length === 0) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Respons-hjelpere (med CORS — endepunktene er offentlige read-only proxyer)
// ---------------------------------------------------------------------------

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function json(
  data: unknown,
  init: { status?: number; cacheSeconds?: number } = {},
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
  };
  if (init.cacheSeconds && init.cacheSeconds > 0) {
    headers["Cache-Control"] = `public, max-age=${init.cacheSeconds}`;
  }
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

/** Preflight-svar for CORS (OPTIONS). */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function etClientName(env: Record<string, string | undefined>): string {
  return env.ET_CLIENT_NAME || DEFAULT_ET_CLIENT_NAME;
}

/** POST en GraphQL-spørring til Entur JP v3. */
export async function enturGraphql(
  env: Record<string, string | undefined>,
  query: string,
  variables: Record<string, unknown>,
): Promise<Response> {
  return fetch(JP_V3_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ET-Client-Name": etClientName(env),
    },
    body: JSON.stringify({ query, variables }),
  });
}

// ---------------------------------------------------------------------------
// Cache API-hjelpere (Cloudflare `caches.default`)
// ---------------------------------------------------------------------------

/** Hent default-cachen (typene mangler i standard-lib → cast). */
export function defaultCache(): {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
} {
  return (caches as unknown as { default: any }).default;
}

/** Bygg en stabil GET-cachenøkkel fra en vilkårlig streng (brukes for POST /trip). */
export async function cacheKeyFor(prefix: string, payload: string): Promise<Request> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request(`https://cache.internal/${prefix}/${hex}`, { method: "GET" });
}
