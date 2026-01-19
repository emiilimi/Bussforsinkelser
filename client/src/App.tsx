import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import StopAnalysis from "@/pages/stop-analysis";
import WorstLists from "@/pages/worst-lists";
import JourneyDetails from "@/pages/journey-details";
import DelayMap from "@/pages/delay-map";
import generatedImage from '@assets/generated_images/minimalist_abstract_transit_map_texture.png';

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/map" component={DelayMap} />
      <Route path="/stops" component={StopAnalysis} />
      <Route path="/worst" component={WorstLists} />
      <Route path="/journey" component={JourneyDetails} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div 
          className="fixed inset-0 z-[-1] opacity-[0.03] pointer-events-none mix-blend-multiply"
          style={{ backgroundImage: `url(${generatedImage})`, backgroundSize: 'cover' }}
        />
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
