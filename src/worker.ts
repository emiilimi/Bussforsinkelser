import { onRequestPost as tripPost, onRequestOptions as tripOptions } from "../functions/api/trip";
import { onRequestGet as geocoderGet, onRequestOptions as geocoderOptions } from "../functions/api/geocoder/autocomplete";
import { onRequestGet as departuresGet, onRequestOptions as departuresOptions } from "../functions/api/departures/[stopPlaceRef]";
import { onRequestGet as serviceJourneyGet, onRequestOptions as serviceJourneyOptions } from "../functions/api/servicejourney/[id]";
import type { PagesContext } from "../functions/api/_entur";

export default {
  async fetch(request: Request, env: Record<string, string | undefined>, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const context: PagesContext = {
      request,
      env,
      params: {},
      waitUntil: (p) => ctx.waitUntil(p),
    };

    // POST /api/trip
    if (path === "/api/trip") {
      if (request.method === "OPTIONS") return tripOptions();
      if (request.method === "POST") return tripPost(context);
    }

    // GET /api/geocoder/autocomplete
    if (path === "/api/geocoder/autocomplete") {
      if (request.method === "OPTIONS") return geocoderOptions();
      if (request.method === "GET") return geocoderGet(context);
    }

    // GET /api/departures/:stopPlaceRef
    const depMatch = path.match(/^\/api\/departures\/(.+)$/);
    if (depMatch) {
      context.params = { stopPlaceRef: decodeURIComponent(depMatch[1]) };
      if (request.method === "OPTIONS") return departuresOptions();
      if (request.method === "GET") return departuresGet(context);
    }

    // GET /api/servicejourney/:id
    const sjMatch = path.match(/^\/api\/servicejourney\/(.+)$/);
    if (sjMatch) {
      context.params = { id: decodeURIComponent(sjMatch[1]) };
      if (request.method === "OPTIONS") return serviceJourneyOptions();
      if (request.method === "GET") return serviceJourneyGet(context);
    }

    // Ukjente /api/-stier skal IKKE få SPA-en (200 + HTML forvirrer klienter
    // som forventer JSON) — svar 404 eksplisitt.
    if (path.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Not an API route — fall through to static assets (SPA)
    return (env as any).ASSETS.fetch(request);
  },
};
