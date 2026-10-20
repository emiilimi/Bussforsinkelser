// ---------------------------------------------------------------------------
// Deling og kopiering som aldri feiler stille.
//
// Bakgrunn (2026-10-19): «Del reisen», «Del» (Uka som gikk) og «Kopier
// tekst/lenke» (Passasjerer) hadde hver sin kopi av samme mønster:
//
//     try { navigator.share ?? navigator.clipboard.writeText(...) } catch {}
//
// Når utklippstavla avviste skrivingen, svelget den tomme catch-en feilen, og
// knappen gjorde synlig INGENTING. Målt med et ekte musklikk i en innebygd
// Chromium: `NotAllowedError: Write permission denied`. Det samme skjer i
// innebygde nettlesere (Facebook, Instagram, Messenger, LinkedIn) — altså
// nettopp der en delt lenke åpnes.
//
// Rekkefølgen under er valgt etter målinger, ikke vane:
//  1. Native delingsark når det finnes (mobil). AbortError = brukeren lukket
//     arket selv; det er et valg, ikke en feil.
//  2. execCommand("copy") SYNKRONT inne i klikket. Foreldet, men virket i
//     samme nettleser som avviste den moderne API-en (målt: ok = true). Den
//     må gå først: Safari godtar den bare mens klikket håndteres, og et
//     `await` foran ville tatt oss ut av det.
//  3. navigator.clipboard.writeText.
//  4. Ingen av delene → "manual": kalleren MÅ vise teksten så brukeren kan
//     kopiere den selv. Se <ShareButton>, som gjør det.
// ---------------------------------------------------------------------------

export type ShareResult = "shared" | "copied" | "cancelled" | "manual";

export type SharePayload = { title?: string; text?: string; url?: string };

/** Teksten slik den kopieres: tekst og lenke på én linje. */
export function shareText({ text, url }: SharePayload): string {
  return [text, url].filter(Boolean).join(" ").trim();
}

/** Kopier via et skjult tekstfelt. Synkront — må kalles inne i klikket. */
function legacyCopy(value: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");          // ingen tastatur på iOS
  ta.style.position = "fixed";              // ingen hopp i scrollposisjonen
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  ta.style.fontSize = "12pt";               // iOS zoomer inn på < 16px-felt ved fokus
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, value.length);

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  if (saved && selection) {
    selection.removeAllRanges();
    selection.addRange(saved);
  }
  active?.focus?.({ preventScroll: true });
  return ok;
}

/**
 * Del (native ark) eller kopier, med reserveløsninger. Returnerer hva som
 * faktisk skjedde. "manual" betyr at kalleren må vise teksten — se docstringen
 * øverst. `mode: "copy"` hopper over delingsarket (for «Kopier»-knapper).
 */
export async function shareOrCopy(
  payload: SharePayload,
  mode: "share" | "copy" = "share",
): Promise<ShareResult> {
  const value = shareText(payload);

  if (mode === "share" && typeof navigator !== "undefined" && typeof navigator.share === "function") {
    const data = { title: payload.title, text: payload.text, url: payload.url };
    const canShare = typeof navigator.canShare !== "function" || navigator.canShare(data);
    if (canShare) {
      try {
        await navigator.share(data);
        return "shared";
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "AbortError") return "cancelled";
        // Annen feil (f.eks. NotAllowedError i innebygde nettlesere): prøv å kopiere.
      }
    }
  }

  if (legacyCopy(value)) return "copied";

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return "copied";
    }
  } catch {
    // Avvist — faller gjennom til manuell kopiering.
  }
  return "manual";
}
