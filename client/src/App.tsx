import { Switch, Route, Redirect } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RegionProvider } from "./lib/RegionContext";
import { IS_REISE } from "./lib/app-mode";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import StopAnalysis from "@/pages/stop-analysis";
import WorstLists from "@/pages/worst-lists";
import JourneyDetails from "@/pages/journey-details";
import DelayMap from "@/pages/delay-map";
import TripPlanner from "@/pages/trip-planner";
import Departures from "@/pages/departures";
import Methodology from "@/pages/methodology";
import generatedImage from '@assets/generated_images/minimalist_abstract_transit_map_texture.png';

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
          <Router />
        </TooltipProvider>
      </RegionProvider>
    </QueryClientProvider>
  );
}

export default App;
