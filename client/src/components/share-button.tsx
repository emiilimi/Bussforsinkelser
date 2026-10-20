import { useEffect, useRef, useState, type ComponentProps, type ComponentType } from "react";
import { Check, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { shareOrCopy, shareText, type SharePayload } from "@/lib/share";

/**
 * Del- eller kopier-knapp som ALLTID gir synlig respons:
 *   delt      → «Delt» med hake
 *   kopiert   → «Kopiert» med hake
 *   avbrutt   → ingenting (brukeren lukket delingsarket selv)
 *   ellers    → et lite vindu med teksten ferdig markert, så den kan kopieres
 *               for hånd
 * Se lib/share.ts for hvorfor — de tidligere knappene feilet stille.
 *
 * `payload` leses ved klikk, ikke ved render, slik at lenken blir adressen
 * siden har NÅR brukeren deler (søket oppdaterer URL-en etter render).
 */
export function ShareButton({
  payload, mode = "share", label, doneLabel, icon: Icon = Share2, iconClassName = "h-3.5 w-3.5 mr-1.5",
  className, ...buttonProps
}: {
  payload: () => SharePayload;
  mode?: "share" | "copy";
  label: string;
  doneLabel?: string;
  icon?: ComponentType<{ className?: string }>;
  iconClassName?: string;
} & Omit<ComponentProps<typeof Button>, "onClick" | "children">) {
  const [status, setStatus] = useState<"idle" | "shared" | "copied">("idle");
  const [manualText, setManualText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function onClick() {
    const p = payload();
    const result = await shareOrCopy(p, mode);
    if (result === "shared" || result === "copied") {
      setStatus(result);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus("idle"), 2000);
    } else if (result === "manual") {
      setManualText(shareText(p));
    }
  }

  const done = status !== "idle";
  const doneText = doneLabel ?? (status === "shared" ? "Delt" : "Kopiert");

  return (
    <Popover open={manualText != null} onOpenChange={(o) => { if (!o) setManualText(null); }}>
      <PopoverAnchor asChild>
        <Button {...buttonProps} className={className} onClick={onClick}>
          {done ? <Check className={iconClassName} /> : <Icon className={iconClassName} />}
          {done ? doneText : label}
        </Button>
      </PopoverAnchor>
      {/* Skjermlesere får vite at noe skjedde, ikke bare seende brukere */}
      <span className="sr-only" aria-live="polite">{done ? doneText : ""}</span>
      <PopoverContent
        className="w-80 space-y-2"
        align="start"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          textRef.current?.focus();
          textRef.current?.select();
        }}
      >
        <p className="text-xs text-muted-foreground">
          Nettleseren lot oss ikke kopiere automatisk. Teksten er markert — kopier den med Ctrl+C
          (⌘C på Mac), eller hold fingeren på den på mobil.
        </p>
        <textarea
          ref={textRef}
          readOnly
          value={manualText ?? ""}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "w-full min-h-[96px] rounded-md border bg-muted/40 p-2 text-xs font-mono resize-none",
            "focus:outline-none focus:ring-2 focus:ring-ring",
          )}
        />
      </PopoverContent>
    </Popover>
  );
}
