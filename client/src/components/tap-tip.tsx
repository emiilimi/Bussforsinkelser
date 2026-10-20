import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Forklaringsboble som virker på ALLE enheter.
 *
 * Erstatter Radix Tooltip for innhold brukeren faktisk trenger å lese.
 * Tooltip åpnes bare ved hover eller tastaturfokus — ikke ved trykk — så på
 * mobil var hvert ⓘ-ikon på siden en død knapp (funnet i knapp-auditen
 * 2026-10-19: klikk ga null DOM-endring). Lenker inne i boblen («Les mer →»,
 * «Se hele avgangen →») var dermed også umulige å nå på mobil.
 *
 *   mus:    hover viser, klikk fester (blir stående når musa går)
 *   touch:  trykk viser / skjuler
 *   tastatur: Enter/mellomrom viser, Escape lukker
 *
 * Triggeren MÅ være et fokuserbart element (helst <button type="button">),
 * ellers når ikke tastaturbrukere innholdet.
 */
export function TapTip({
  children, content, className, side = "top", align = "center",
}: {
  children: ReactNode;
  content: ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const hoverOpen = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  // Liten forsinkelse så musa rekker over til boblen (for lenker i den)
  const hoverClose = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || pinned.current) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) pinned.current = false; }}>
      <PopoverTrigger
        asChild
        onClick={(e) => {
          // Overstyr Radix' egen veksling: klikk FESTER boblen (eller løsner den)
          e.preventDefault();
          e.stopPropagation();
          if (pinned.current) { pinned.current = false; setOpen(false); }
          else { pinned.current = true; setOpen(true); }
        }}
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
        // Ikke stjel fokus ved hover — det ville scrollet og forvirret skjermlesere
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn("w-auto max-w-xs p-2.5 text-xs leading-snug", className)}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
