// GET /api/geocoder/reverse?lat=60.39&lng=5.32
// Proxy til Entur sin reverse-geocoder — finner nærmeste sted/adresse for et
// koordinatpar. Brukes av «Min posisjon» i reiseplanleggeren slik at brukeren
// kan se HVOR posisjonen ble tolket til å være (nyttig for å vurdere om
// nettleserens posisjon faktisk er treffsikker).

import {
  PagesContext, GEOCODER_REVERSE_URL, etClientName,
  json, preflight, defaultCache,
} from "../_entur";

const CACHE_SECONDS = 5 * 60;

export const onRequestOptions = () => preflight();

export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ error: "lat/lng required" }, { status: 400 });
  }

  const cache = defaultCache();
  // Avrund til ~11m presisjon i cachenøkkelen — nok for gjenbruk uten å
  // slå sammen faktisk ulike posisjoner.
  const cacheKey = new Request(
    `https://cache.internal/geocoder-reverse?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}`,
    { method: "GET" },
  );
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const enturUrl = `${GEOCODER_REVERSE_URL}?point.lat=${lat}&point.lon=${lng}&size=1&lang=no`;
    const response = await fetch(enturUrl, {
      headers: { "ET-Client-Name": etClientName(context.env) },
    });
    if (!response.ok) {
      return json({ error: "Geocoder error" }, { status: 502 });
    }
    const data: any = await response.json();
    const f = (data.features || [])[0];
    const result = f
      ? {
          id: f.properties.id,
          name: f.properties.name,
          label: f.properties.label,
          layer: f.properties.layer,
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0],
        }
      : null;

    const out = json(result, { cacheSeconds: CACHE_SECONDS });
    context.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch {
    return json({ error: "Geocoder unreachable" }, { status: 502 });
  }
};
