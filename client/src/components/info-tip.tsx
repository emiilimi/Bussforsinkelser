import { Info } from "lucide-react";
import { Link } from "wouter";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Lite info-ikon med tooltip. Hvis `learnMoreHref` er satt, vises en
 * "Les mer →"-lenke i tooltipen som peker til relevant seksjon på /metode.
 *
 * Definert på modulnivå — IKKE flytt inn i en annen komponent (det får
 * tooltipen til å lukkes ved hver re-render fordi React unmount/remount-er).
 */
export function InfoTip({
  children,
  learnMoreHref,
  ariaLabel = "Info",
}: {
  children: React.ReactNode;
  learnMoreHref?: string;
  ariaLabel?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex items-center text-muted-foreground hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-snug">
        <div className="space-y-1.5">
          <div>{children}</div>
          {learnMoreHref && (
            <Link
              href={learnMoreHref}
              className="text-primary hover:underline inline-block"
            >
              Les mer →
            </Link>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
