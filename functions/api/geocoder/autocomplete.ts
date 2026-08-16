// GET /api/geocoder/autocomplete?text=Bryggen+Bergen&size=8
// Proxy til Entur Geocoder — returnerer stoppesteder OG adresser.
// Port av app.get("/api/geocoder/autocomplete", …) fra server/routes.ts.

import {
  PagesContext, GEOCODER_URL, etClientName,
  json, preflight, parseIntParam, defaultCache,
} from "../_entur";

const CACHE_SECONDS = 5 * 60; // autocomplete-resultater er stabile

export const onRequestOptions = () => preflight();

export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  const url = new URL(context.request.url);
  const text = (url.searchParams.get("text") || "").trim().slice(0, 200);
  if (text.length < 2) return json([]);

  const size = Math.min(Math.max(1, parseIntParam(url.searchParams.get("size"), 8)), 20);

  const cache = defaultCache();
  // Stabil cachenøkkel (normaliserte parametre).
  const cacheKey = new Request(
    `https://cache.internal/geocoder?text=${encodeURIComponent(text)}&size=${size}`,
    { method: "GET" },
  );
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const enturUrl = `${GEOCODER_URL}?text=${encodeURIComponent(text)}&size=${size}&lang=no`;
    const response = await fetch(enturUrl, {
      headers: { "ET-Client-Name": etClientName(context.env) },
    });
    if (!response.ok) {
      return json({ error: "Geocoder error" }, { status: 502 });
    }
    const data: any = await response.json();
    const results = (data.features || []).map((f: any) => ({
      id: f.properties.id,
      name: f.properties.name,
      label: f.properties.label,
      layer: f.properties.layer, // "venue" = stopp, "address" = adresse, "street", …
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      // Kommune/by — brukt til å disambiguere navneduplikater i søkeresultatet
      // (Norge har flere stoppesteder med identisk navn, f.eks. "Kringsjå" i
      // Oslo/Bergen/Fredrikstad/Vennesla). Se disambiguationSuffix() i klienten.
      locality: f.properties.locality ?? null,
      // Beste gjetning på operatør fra tariffsone-prefikset (ikke samme
      // navnerom som dataSource, men sammenfaller i praksis for regionene i
      // REGION_OPERATOR — brukes kun til visning, aldri til filtrering).
      operatorHint: f.properties.tariff_zones?.[0]?.split(":")[0] ?? null,
    }));

    const out = json(results, { cacheSeconds: CACHE_SECONDS });
    context.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch {
    return json({ error: "Geocoder unreachable" }, { status: 502 });
  }
};
