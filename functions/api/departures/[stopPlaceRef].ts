// GET /api/departures/:stopPlaceRef?minutes=90&limit=50
// Kommende avganger fra et stoppested via Entur stopPlace/quay estimatedCalls.
// Port av app.get("/api/departures/:stopPlaceRef", …) fra server/routes.ts.
//
// Caching: 60 sek (sanntid) via Cloudflare Cache API.

import {
  PagesContext, etClientName, JP_V3_URL,
  json, preflight, parseIntParam, defaultCache,
} from "../_entur";

const CACHE_SECONDS = 60;

export const onRequestOptions = () => preflight();

export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  const raw = context.params.stopPlaceRef;
  const stopPlaceRef = Array.isArray(raw) ? raw.join(",") : String(raw);
  if (!/^NSR:(StopPlace|Quay):\d+$/.test(stopPlaceRef)) {
    return json({ error: "Invalid stopPlaceRef" }, { status: 400 });
  }

  const url = new URL(context.request.url);
  const minutes = Math.min(Math.max(parseIntParam(url.searchParams.get("minutes"), 90), 15), 360);
  const limit = Math.min(Math.max(parseIntParam(url.searchParams.get("limit"), 50), 5), 100);

  const cache = defaultCache();
  const cacheKey = new Request(
    `https://cache.internal/departures/${encodeURIComponent(stopPlaceRef)}?minutes=${minutes}&limit=${limit}`,
    { method: "GET" },
  );
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const isQuay = stopPlaceRef.startsWith("NSR:Quay:");
  const rootSelector = isQuay ? "quay" : "stopPlace";
  const query = `
    query StopDepartures($id: String!, $range: Int!, $n: Int!) {
      ${rootSelector}(id: $id) {
        id
        name
        estimatedCalls(timeRange: $range, numberOfDepartures: $n) {
          aimedDepartureTime
          expectedDepartureTime
          realtime
          cancellation
          destinationDisplay { frontText }
          quay { id name publicCode }
          serviceJourney {
            id
            directionType
            line { id publicCode name transportMode }
          }
        }
      }
    }`;

  try {
    const response = await fetch(JP_V3_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ET-Client-Name": etClientName(context.env),
      },
      body: JSON.stringify({
        query,
        variables: { id: stopPlaceRef, range: minutes * 60, n: limit },
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error("[departures] Entur HTTP error:", response.status, text.slice(0, 300));
      return json({ error: "Avgangstjenesten er ikke tilgjengelig akkurat nå." }, { status: 502 });
    }
    const data: any = await response.json();
    if (data.errors) {
      console.error("[departures] GraphQL errors:", JSON.stringify(data.errors).slice(0, 500));
    }
    const place = data?.data?.[rootSelector];
    if (!place) {
      return json({ stopName: null, departures: [] });
    }

    const calls = (place.estimatedCalls ?? []) as Array<any>;
    const departures = calls.map((c) => ({
      aimedTime: c.aimedDepartureTime,
      expectedTime: c.expectedDepartureTime,
      realtime: !!c.realtime,
      cancelled: !!c.cancellation,
      destination: c.destinationDisplay?.frontText ?? null,
      quayRef: c.quay?.id ?? null,
      quayName: c.quay?.name ?? null,
      platform: c.quay?.publicCode ?? null,
      lineRef: c.serviceJourney?.line?.id ?? null,
      lineNumber: c.serviceJourney?.line?.publicCode ?? null,
      lineName: c.serviceJourney?.line?.name ?? null,
      transportMode: c.serviceJourney?.line?.transportMode ?? null,
      serviceJourneyId: c.serviceJourney?.id ?? null,
      directionRef: c.serviceJourney?.directionType ?? null,
    }));

    const out = json({ stopName: place.name, stopRef: place.id, departures }, { cacheSeconds: CACHE_SECONDS });
    context.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch (err: any) {
    console.error("[departures] Entur unreachable:", err?.message);
    return json({ error: "Avgangstjenesten er ikke tilgjengelig akkurat nå." }, { status: 502 });
  }
};
