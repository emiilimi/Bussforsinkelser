// POST /api/trip — Entur Journey Planner v3 proxy (Cloudflare Pages Function).
//
// Port av app.post("/api/trip", …) fra server/routes.ts. Nytt i denne versjonen:
//   • pageCursor-støtte (tidligere/senere avganger — Fase 4)
//   • nextPageCursor / previousPageCursor i svaret
//   • pointsOnLink { points } per leg (kartgeometri for gangstrekk — Fase 4)
//
// Caching: 5 min via Cloudflare Cache API, nøklet på hele filter-fingeravtrykket.

import {
  PagesContext, TRANSPORT_MODES, STREET_MODES, clampNumber,
  json, preflight, enturGraphql, defaultCache, cacheKeyFor,
} from "./_entur";

const CACHE_SECONDS = 5 * 60;

export const onRequestOptions = () => preflight();

export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  let body: any;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "Ugyldig JSON-body" }, { status: 400 });
  }

  const {
    from, to, when,
    arriveBy,
    transportModes,
    accessMode,
    egressMode,
    directMode,
    walkSpeed,
    transferSlack,
    maximumTransfers,
    numTripPatterns,
    wheelchairAccessible,
    searchWindow,
    pageCursor,
  } = body ?? {};

  if (!from || !to) {
    return json({ error: "from and to required (Location object or NSR:StopPlace string)" }, { status: 400 });
  }

  if (
    transportModes !== undefined &&
    (!Array.isArray(transportModes) ||
      transportModes.some((m: unknown) => typeof m !== "string" || !TRANSPORT_MODES.has(m)))
  ) {
    return json({ error: "Ugyldig transportModes" }, { status: 400 });
  }
  const safeAccessMode =
    typeof accessMode === "string" && STREET_MODES.has(accessMode) ? accessMode : "foot";
  const safeEgressMode =
    typeof egressMode === "string" && STREET_MODES.has(egressMode) ? egressMode : "foot";
  const safeDirectMode =
    typeof directMode === "string" && STREET_MODES.has(directMode) ? directMode : null;
  // pageCursor er en ugjennomsiktig Entur-token (base64-aktig). Tillat bare et
  // konservativt tegnsett så den ikke kan injiseres som GraphQL — den sendes
  // riktignok som variabel, men vi vil ikke videresende søppel.
  const safePageCursor =
    typeof pageCursor === "string" && /^[A-Za-z0-9+/=_-]{1,512}$/.test(pageCursor)
      ? pageCursor
      : null;

  const fromLocation = typeof from === "string" ? { place: from } : from;
  const toLocation = typeof to === "string" ? { place: to } : to;
  const dateTime = when || new Date().toISOString();

  // Filter-fingeravtrykk → cachenøkkel. Inkluder pageCursor så tidligere/senere
  // sider caches separat.
  const fingerprint = JSON.stringify({
    f: fromLocation, t: toLocation,
    m: transportModes ?? null,
    ab: arriveBy ?? null,
    ws: walkSpeed ?? null,
    ts: transferSlack ?? null,
    mt: maximumTransfers ?? null,
    wc: wheelchairAccessible ?? null,
    sw: searchWindow ?? null,
    np: numTripPatterns ?? null,
    am: accessMode ?? null,
    em: egressMode ?? null,
    dm: directMode ?? null,
    pc: safePageCursor,
    dt: dateTime,
  });

  const cache = defaultCache();
  const cacheKey = await cacheKeyFor("trip", fingerprint);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // Bygg transport-modes (default: alle vanlige kollektivmoduser)
  const modes = (Array.isArray(transportModes) && transportModes.length > 0)
    ? transportModes
    : ["bus", "tram", "rail", "metro", "water", "coach"];
  const transportModesGql = modes.map((m: string) => `{ transportMode: ${m} }`).join(", ");

  const directModeGql = safeDirectMode ? `directMode: ${safeDirectMode}` : "";
  const modesBlock = [
    `transportModes: [${transportModesGql}]`,
    `accessMode: ${safeAccessMode}`,
    `egressMode: ${safeEgressMode}`,
    directModeGql,
  ].filter(Boolean).join(", ");

  const optionals: string[] = [];
  if (arriveBy === true) optionals.push("arriveBy: true");
  const safeWalkSpeed = clampNumber(walkSpeed, 0.5, 5);
  if (safeWalkSpeed !== null) optionals.push(`walkSpeed: ${safeWalkSpeed}`);
  const safeTransferSlack = clampNumber(transferSlack, 0, 3600);
  if (safeTransferSlack !== null) optionals.push(`transferSlack: ${Math.round(safeTransferSlack)}`);
  const safeMaxTransfers = clampNumber(maximumTransfers, 0, 10);
  if (safeMaxTransfers !== null) optionals.push(`maximumTransfers: ${Math.round(safeMaxTransfers)}`);
  if (wheelchairAccessible === true) optionals.push("wheelchairAccessible: true");
  const safeSearchWindow = clampNumber(searchWindow, 1, 2880);
  if (safeSearchWindow !== null) optionals.push(`searchWindow: ${Math.round(safeSearchWindow)}`);
  const numPatterns = Math.min(Math.max(1, Math.round(Number(numTripPatterns) || 5)), 12);
  optionals.push(`numTripPatterns: ${numPatterns}`);
  // pageCursor sendes som variabel; når satt overstyrer den dateTime/searchWindow
  // internt hos Entur (tidligere/senere-paginering).
  if (safePageCursor) optionals.push("pageCursor: $pageCursor");

  const cursorDecl = safePageCursor ? ", $pageCursor: String" : "";
  const query = `
    query trip($from: Location!, $to: Location!, $dateTime: DateTime!${cursorDecl}) {
      trip(
        from: $from
        to: $to
        dateTime: $dateTime
        modes: { ${modesBlock} }
        ${optionals.join("\n        ")}
      ) {
        nextPageCursor
        previousPageCursor
        tripPatterns {
          expectedStartTime
          expectedEndTime
          duration
          legs {
            mode
            transportSubmode
            fromPlace { name quay { id name } }
            toPlace { name quay { id name } }
            line { id publicCode name }
            expectedStartTime
            expectedEndTime
            duration
            distance
            pointsOnLink { points }
            intermediateQuays { id name }
            serviceJourney {
              id
              passingTimes {
                quay { id }
                departure { time dayOffset }
                arrival { time dayOffset }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const variables: Record<string, unknown> = { from: fromLocation, to: toLocation, dateTime };
    if (safePageCursor) variables.pageCursor = safePageCursor;

    const response = await enturGraphql(context.env, query, variables);
    if (!response.ok) {
      const text = await response.text();
      console.error("[trip] Entur HTTP error:", response.status, text.slice(0, 500));
      return json({ error: "Reisetjenesten er ikke tilgjengelig akkurat nå." }, { status: 502 });
    }

    const data = await response.json();
    if ((data as any).errors) {
      console.error("[trip] GraphQL errors:", JSON.stringify((data as any).errors).slice(0, 500));
    }

    const out = json(data, { cacheSeconds: CACHE_SECONDS });
    // Lagre i cache i bakgrunnen (klon — body kan bare leses én gang).
    context.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch (err: any) {
    console.error("[trip] Entur unreachable:", err?.message);
    return json({ error: "Reisetjenesten er ikke tilgjengelig akkurat nå." }, { status: 502 });
  }
};
