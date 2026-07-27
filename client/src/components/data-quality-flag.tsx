// ---------------------------------------------------------------------------
// «Mulig datafeil»-merking av urimelig store forsinkelsestall.
//
// Prinsipp (etter brukerens eksplisitte ønske): vi FILTRERER IKKE bort tall
// som ser for gode/dårlige ut til å være sanne — det er ikke vår vurdering å
// gjøre på brukerens vegne. Vi MERKER dem i stedet, så leseren ser både tallet
// og forbeholdet og kan bedømme selv.
//
// Terskel: 120 minutter. Samme grense som pipelinen allerede bruker når den
// logger uteliggere til `data_quality_log` (se pipeline/ingest.py), så UI og
// datagrunnlag snakker om «uteligger» på samme måte.
//
// Typiske årsaker til slike tall: avganger som aldri ble avsluttet i
// sanntidsfeeden, feilregistrerte rutetider, eller kansellerte turer som
// rapporteres med en enorm «forsinkelse» i stedet for som kansellert.
// ---------------------------------------------------------------------------

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export const IMPLAUSIBLE_DELAY_MIN = 120;

/** Er dette forsinkelsestallet så stort at det sannsynligvis er en datafeil? */
export function isImplausibleDelay(delayMin: number | null | undefined): boolean {
  return delayMin != null && Math.abs(delayMin) >= IMPLAUSIBLE_DELAY_MIN;
}

/**
 * Liten «mulig datafeil»-markør. Vis den ved siden av tallet — ikke i stedet
 * for det.
 */
export function DataQualityFlag({
  delayMin,
  className,
  withText = false,
}: {
  delayMin: number | null | undefined;
  className?: string;
  /** true = vis teksten «mulig datafeil», ikke bare varselikonet. */
  withText?: boolean;
}) {
  if (!isImplausibleDelay(delayMin)) return null;
  const title =
    `Over ${IMPLAUSIBLE_DELAY_MIN} minutter — sannsynligvis en datafeil ` +
    `(f.eks. avgang som aldri ble avsluttet i sanntidsdataene, eller feil rutetid). ` +
    `Tallet vises som det er, men bør ikke leses som en reell forsinkelse.`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400 align-middle",
        className,
      )}
      title={title}
    >
      <AlertTriangle className="h-3 w-3 flex-shrink-0" />
      {withText && <span className="text-[10px] font-medium">mulig datafeil</span>}
    </span>
  );
}
