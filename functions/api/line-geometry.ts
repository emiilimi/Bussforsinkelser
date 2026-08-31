// GET /api/line-geometry?line=RUT:Line:5[&direction=inbound|outbound][&max=3]
//
// Rutevarianter med geometri for ÉN linje — datagrunnlaget for kartet på
// linjeanalysen.
//
// ---------------------------------------------------------------------------
// Hvorfor Entur og ikke våre egne parquet-data:
//
// Parquet har ingen koordinater i det hele tatt (bare stop_ref/stop_name), og
// «rutevariantene» vi kan utlede derfra er delvis FALSKE. Målt på RUT:Line:5
// retning 1 (2026-08-27): vår nest hyppigste «variant» var «Stortinget →
// Nydalen», 8 stopp, 3196 kjøringer — men Entur har ingen variant som starter
// på Stortinget. Kjøretøyet begynner bare å rapportere sanntid der. Samme
// årsak til at vår hovedvariant hadde 33 stopp mens Entur har 43: de 10
// resterende rapporterer ikke.
//
// Derfor: Entur eier geometrien OG variantlista (fasit), vi eier fargene.
//
// journeyPatterns, ikke serviceJourneys: et journeyPattern ER en rutevariant.
// RUT:Line:5 har 51 patterns mot 2798 serviceJourneys — samme informasjon,
// ~50x mindre å hente.
// ---------------------------------------------------------------------------
//
// Caching: 24 t. Rutegeometri endres bare ved ruteendring.

import {
  PagesContext, etClientName, JP_V3_URL,
  json, preflight, parseIntParam, defaultCache,
} from "./_entur";

const CACHE_SECONDS = 24 * 60 * 60;

// Maks varianter vi returnerer per retning. Fullt svar fra Entur er opptil
// ~400 kB (51 patterns med geometri); vi filtrerer NED til de mest kjørte før
// vi svarer klienten, så nettleseren aldri ser den mengden.
const DEFAULT_MAX_VARIANTS = 3;

type EnturQuay = { id: string; name: string | null; latitude: number | null; longitude: number | null };
type EnturPattern = {
  id: string;
  directionType: string | null;
  pointsOnLink: { points: string | null } | null;
  quays: EnturQuay[];
  serviceJourneys: Array<{ id: string }>;
};

const QUERY = `
  query LineGeometry($id: ID!) {
    line(id: $id) {
      id
      publicCode
      name
      transportMode
      journeyPatterns {
        id
        directionType
        pointsOnLink { points }
        quays { id name latitude longitude }
        serviceJourneys { id }
      }
    }
  }
`;

export const onRequestOptions = () => preflight();

export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  const url = new URL(context.request.url);
  const lineRef = (url.searchParams.get("line") || "").trim();
  // Konservativt tegnsett — verdien går inn i en GraphQL-variabel, men vi
  // avviser åpenbart feilformede refs tidlig framfor å kalle Entur unødig.
  if (!/^[A-Za-z0-9:_\-.]{3,128}$/.test(lineRef)) {
    return json({ error: "Invalid line ref" }, { status: 400 });
  }
  const dirRaw = url.searchParams.get("direction");
  const direction = dirRaw === "inbound" || dirRaw === "outbound" ? dirRaw : null;
  const max = Math.min(Math.max(1, parseIntParam(url.searchParams.get("max"), DEFAULT_MAX_VARIANTS)), 6);

  const cache = defaultCache();
  const cacheKey = new Request(
    `https://cache.internal/line-geometry?line=${encodeURIComponent(lineRef)}&dir=${direction ?? "all"}&max=${max}`,
    { method: "GET" },
  );
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const response = await fetch(JP_V3_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ET-Client-Name": etClientName(context.env) },
      body: JSON.stringify({ query: QUERY, variables: { id: lineRef } }),
    });
    if (!response.ok) return json({ error: "Entur error" }, { status: 502 });

    const body: any = await response.json();
    if (body.errors?.length) {
      return json({ error: body.errors[0]?.message ?? "GraphQL error" }, { status: 502 });
    }
    const line = body.data?.line;
    if (!line) return json({ error: "Line not found" }, { status: 404 });

    const patterns: EnturPattern[] = line.journeyPatterns ?? [];
    const variants = patterns
      .filter((p) => {
        if (direction && p.directionType !== direction) return false;
        if (!p.pointsOnLink?.points) return false;
        // Trenger minst to stopp med koordinat for å kunne tegne noe.
        return p.quays.filter((q) => q.latitude != null && q.longitude != null).length >= 2;
      })
      // «Mest kjørt» = antall serviceJourneys i ruteplanen. Merk at vi IKKE
      // rangerer på våre egne observasjoner: de teller rader (kjøringer ×
      // stopp), så lange varianter ville vunnet på lengde, og de er dessuten
      // forurenset av sanntidshull (se filhodet).
      .sort((a, b) => b.serviceJourneys.length - a.serviceJourneys.length)
      .slice(0, max)
      .map((p) => ({
        id: p.id,
        directionType: p.directionType,
        points: p.pointsOnLink!.points,
        runs: p.serviceJourneys.length,
        quays: p.quays
          .filter((q) => q.latitude != null && q.longitude != null)
          .map((q) => ({ id: q.id, name: q.name, lat: q.latitude, lng: q.longitude })),
      }));

    const out = json(
      {
        lineRef: line.id,
        publicCode: line.publicCode ?? null,
        name: line.name ?? null,
        transportMode: line.transportMode ?? null,
        totalPatterns: patterns.length,
        variants,
      },
      { cacheSeconds: CACHE_SECONDS },
    );
    context.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch {
    return json({ error: "Entur unreachable" }, { status: 502 });
  }
};
