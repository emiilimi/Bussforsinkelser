// ---------------------------------------------------------------------------
// Delte byggeklosser for stoppsøk med favoritter.
//
// Brukes av BÅDE reiseplanleggeren og «Avganger og stopp», slik at stjernen
// oppfører seg likt begge steder og favorittlista er den samme (lagres i
// localStorage av lib/stop-history.ts — samme nøkkel for begge sidene, så et
// stopp du stjernemerker i reiseplanleggeren dukker opp på avgangssiden også).
// ---------------------------------------------------------------------------

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </p>
  );
}

/**
 * Én rad i søkelista: velg stedet, eller slå favoritt av/på med stjernen.
 *
 * Stjernen var tidligere `text-muted-foreground/40` — så svak at brukere ikke
 * fant funksjonen i det hele tatt. Den er nå fullt synlig i grått og fylles
 * gul når stoppet er en favoritt.
 */
export function StopRow({
  icon, title, subtitle, isFav, onPick, onToggleFav,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  isFav: boolean;
  onPick: () => void;
  onToggleFav: () => void;
}) {
  return (
    <div className="flex items-center hover:bg-muted/50 transition-colors">
      <button
        className="flex-1 min-w-0 text-left px-3 py-2 text-sm flex items-start gap-2"
        onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      >
        <span className="mt-0.5 flex-shrink-0">{icon}</span>
        <span className="min-w-0">
          <span className="block truncate">{title}</span>
          {subtitle && (
            <span className="block text-xs text-muted-foreground truncate">{subtitle}</span>
          )}
        </span>
      </button>
      <button
        className="px-2.5 py-2 flex-shrink-0 rounded hover:bg-amber-400/10"
        title={isFav ? "Fjern favoritt" : "Lagre som favoritt"}
        aria-label={isFav ? "Fjern favoritt" : "Lagre som favoritt"}
        aria-pressed={isFav}
        onMouseDown={(e) => { e.preventDefault(); onToggleFav(); }}
      >
        <Star
          className={cn(
            "h-4 w-4 transition-colors",
            isFav ? "fill-amber-400 text-amber-400" : "text-muted-foreground hover:text-amber-500",
          )}
        />
      </button>
    </div>
  );
}

/**
 * Stjerneknapp for ETT valgt stoppested — vises ved siden av overskriften på
 * avgangssiden. Der er dette den synlige inngangen til favoritter: du ser
 * allerede på stoppet, og kan merke det uten å gå tilbake til søkefeltet.
 */
export function FavoriteToggle({
  isFav, onToggle, className,
}: {
  isFav: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={isFav}
      aria-label={isFav ? "Fjern fra favoritter" : "Lagre som favoritt"}
      title={isFav ? "Fjern fra favoritter" : "Lagre som favoritt"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        isFav
          ? "border-amber-400/40 bg-amber-400/10 text-amber-600 dark:text-amber-400"
          : "border-border text-muted-foreground hover:border-amber-400/40 hover:text-amber-600",
        className,
      )}
    >
      <Star className={cn("h-3.5 w-3.5", isFav && "fill-amber-400 text-amber-400")} />
      {isFav ? "Favoritt" : "Lagre favoritt"}
    </button>
  );
}
