import { Switch, Route, Redirect } from "wouter";
import { useEffect, lazy, Suspense } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RegionProvider } from "./lib/RegionContext";
import { IS_REISE } from "./lib/app-mode";
import generatedImage from '@assets/generated_images/minimalist_abstract_transit_map_texture.png';

// Rute-nivå code splitting (juli 2026): sidene lazy-lastes slik at hver rute
// får sin egen chunk. Uten dette skipte hele appen som ÉN 1,44 MB JS-fil
// (Leaflet + Recharts + alle sider) på hver eneste sidelast — tungt på mobil.
// Nå laster f.eks. reiseplanleggeren uten Leaflet, og kartet uten Recharts.
const NotFound = lazy(() => import("@/pages/not-found"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const StopAnalysis = lazy(() => import("@/pages/stop-analysis"));
const WorstLists = lazy(() => import("@/pages/worst-lists"));
const JourneyDetails = lazy(() => import("@/pages/journey-details"));
const DelayMap = lazy(() => import("@/pages/delay-map"));
const TripPlanner = lazy(() => import("@/pages/trip-planner"));
const Departures = lazy(() => import("@/pages/departures"));
const Methodology = lazy(() => import("@/pages/methodology"));

// Enkel, lett fallback mens en rute-chunk lastes (vanligvis <1 sek).
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
      Laster…
    </div>
  );
}

// Full analysenettsted (default build) — alle sider, SQLite-backend.
function FullRouter() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/map" component={DelayMap} />
      <Route path="/stops" component={StopAnalysis} />
      <Route path="/worst" component={WorstLists} />
      <Route path="/journey" component={JourneyDetails} />
      <Route path="/reise" component={TripPlanner} />
      <Route path="/avganger" component={Departures} />
      <Route path="/metode" component={Methodology} />
      <Route component={NotFound} />
    </Switch>
  );
}

// Frittstående reise-side (VITE_APP=reise). Analysesidene (full offload)
// serveres fra R2-artefakter + DuckDB-WASM via stats-adapteren — ingen
// SQLite-backend. /stops gjenstår (trenger stoppesøk/retnings-adaptere).
function ReiseRouter() {
  return (
    <Switch>
      <Route path="/"><Redirect to="/reise" /></Route>
      <Route path="/reise" component={TripPlanner} />
      <Route path="/avganger" component={Departures} />
      <Route path="/oversikt" component={Dashboard} />
      <Route path="/journey" component={JourneyDetails} />
      <Route path="/worst" component={WorstLists} />
      <Route path="/map" component={DelayMap} />
      <Route path="/metode" component={Methodology} />
      <Route component={NotFound} />
    </Switch>
  );
}

const Router = IS_REISE ? ReiseRouter : FullRouter;

function App() {
  useEffect(() => {
    if (IS_REISE) document.title = "Reiseplanlegger — emoldestad.no";
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <RegionProvider>
        <TooltipProvider>
          <div
            className="fixed inset-0 z-[-1] opacity-[0.03] pointer-events-none mix-blend-multiply"
            style={{ backgroundImage: `url(${generatedImage})`, backgroundSize: 'cover' }}
          />
          <Toaster />
          <Suspense fallback={<RouteLoading />}>
            <Router />
          </Suspense>
        </TooltipProvider>
      </RegionProvider>
    </QueryClientProvider>
  );
}

export default App;
