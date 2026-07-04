// GET /api/servicejourney/:id?date=YYYY-MM-DD
// Full stoppliste for én avgang (serviceJourney) med planlagte tider og
// sanntid per stopp. Brukes av avgangssiden når man klikker på en avgang.
//
// Caching: 60 sek (sanntid) via Cloudflare Cache API.

import {
  PagesContext, etClientName, JP_V3_URL,
  json, preflight, defaultCache,
} from "../_entur";

const CACHE_SECONDS = 60;

export const onRequestOptions = () => preflight();

export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  const raw = context.params.id;
  const id = Array.isArray(raw) ? raw.join(",") : String(raw);
  // SJ-ider er f.eks. "SKY:ServiceJourney:1B-207005-21704063" — konservativt tegnsett
  if (!/^[A-Za-z0-9:_\-.]{1,128}$/.test(id)) {
    return json({ error: "Invalid serviceJourneyId" }, { status: 400 });
  }

  const url = new URL(context.request.url);
  const dateRaw = url.searchParams.get("date");
  const date =
    dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
      ? dateRaw
      : new Date().toISOString().slice(0, 10);

  const cache = defaultCache();
  const cacheKey = new Request(
    `https://cache.internal/servicejourney/${encodeURIComponent(id)}?date=${date}`,
    { method: "GET" },
  );
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const query = `
    query SJ($id: String!, $date: Date!) {
      serviceJourney(id: $id) {
        id
        line { id publicCode name transportMode }
        estimatedCalls(date: $date) {
          quay { id name publicCode }
          aimedArrivalTime
          expectedArrivalTime
          aimedDepartureTime
          expectedDepartureTime
          realtime
          cancellation
          destinationDisplay { frontText }
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
      body: JSON.stringify({ query, variables: { id, date } }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error("[servicejourney] Entur HTTP error:", response.status, text.slice(0, 300));
      return json({ error: "Tjenesten er ikke tilgjengelig akkurat nå." }, { status: 502 });
    }
    const data: any = await response.json();
    if (data.errors) {
      console.error("[servicejourney] GraphQL errors:", JSON.stringify(data.errors).slice(0, 500));
    }
    const sj = data?.data?.serviceJourney;
    if (!sj) {
      return json({ serviceJourneyId: id, line: null, calls: [] });
    }

    const calls = (sj.estimatedCalls ?? []).map((c: any) => ({
      quayRef: c.quay?.id ?? null,
      quayName: c.quay?.name ?? null,
      platform: c.quay?.publicCode ?? null,
      aimedArrival: c.aimedArrivalTime ?? null,
      expectedArrival: c.expectedArrivalTime ?? null,
      aimedDeparture: c.aimedDepartureTime ?? null,
      expectedDeparture: c.expectedDepartureTime ?? null,
      realtime: !!c.realtime,
      cancelled: !!c.cancellation,
      destination: c.destinationDisplay?.frontText ?? null,
    }));

    const out = json(
      {
        serviceJourneyId: sj.id,
        line: sj.line
          ? {
              lineRef: sj.line.id,
              publicCode: sj.line.publicCode,
              name: sj.line.name,
              transportMode: sj.line.transportMode,
            }
          : null,
        date,
        calls,
      },
      { cacheSeconds: CACHE_SECONDS },
    );
    context.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch (err: any) {
    console.error("[servicejourney] Entur unreachable:", err?.message);
    return json({ error: "Tjenesten er ikke tilgjengelig akkurat nå." }, { status: 502 });
  }
};
