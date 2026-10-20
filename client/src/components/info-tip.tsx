import { Info } from "lucide-react";
import { Link } from "wouter";
import { TapTip } from "@/components/tap-tip";

/**
 * Lite info-ikon med forklaring. Hvis `learnMoreHref` er satt, vises en
 * "Les mer →"-lenke som peker til relevant seksjon på /metode.
 *
 * Bygget på TapTip, ikke Tooltip: Tooltip åpnes ikke ved trykk, så ikonet var
 * dødt på mobil (se tap-tip.tsx).
 *
 * Definert på modulnivå — IKKE flytt inn i en annen komponent (det får
 * boblen til å lukkes ved hver re-render fordi React unmount/remount-er).
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
    <TapTip
      content={
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
      }
    >
      <button
        type="button"
        aria-label={ariaLabel}
        className="inline-flex items-center text-muted-foreground hover:text-foreground"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    </TapTip>
  );
}
