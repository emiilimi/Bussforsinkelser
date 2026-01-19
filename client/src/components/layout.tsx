import { Link, useLocation } from "wouter";
import { Bus, BarChart3, AlertTriangle, Map, Clock, Map as MapIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: BarChart3 },
    { href: "/map", label: "Delay Map", icon: MapIcon },
    { href: "/stops", label: "Stop Analysis", icon: Map },
    { href: "/worst", label: "Worst Lists", icon: AlertTriangle },
    { href: "/journey", label: "Journey Check", icon: Clock },
  ];

  return (
    <div className="min-h-screen bg-background font-sans text-foreground flex flex-col md:flex-row">
      <aside className="w-full md:w-64 border-b md:border-r border-border bg-card/50 backdrop-blur-sm p-4 md:h-screen md:sticky md:top-0 flex flex-col gap-8 z-50">
        <div className="flex items-center gap-3 px-2">
          <div className="bg-primary text-primary-foreground p-2 rounded-lg">
            <Bus className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight leading-none text-primary">bussforsinkelser.no</h1>
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mt-1">Vestland & Entur</p>
          </div>
        </div>

        <nav className="flex flex-row md:flex-col gap-1 overflow-x-auto md:overflow-visible no-scrollbar">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <a className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200",
                  isActive 
                    ? "bg-primary text-primary-foreground shadow-sm" 
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}>
                  <item.icon className={cn("w-4 h-4", isActive ? "text-primary-foreground" : "text-muted-foreground")} />
                  {item.label}
                </a>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto hidden md:block px-2">
          <div className="p-4 rounded-lg bg-muted/50 border border-border text-xs text-muted-foreground">
            <p className="font-semibold mb-1">Entur Data Hub</p>
            <p>Unified Siri Realtime Dataset</p>
            <p className="mt-1 opacity-70">Region: All Norway</p>
          </div>
        </div>
      </aside>

      <main className="flex-1 p-4 md:p-8 overflow-y-auto w-full max-w-7xl mx-auto">
        {children}
      </main>
    </div>
  );
}
