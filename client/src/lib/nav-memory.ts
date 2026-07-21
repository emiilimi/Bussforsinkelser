// ---------------------------------------------------------------------------
// Husker den sist besøkte fulle URL-en (sti + query) per sidemeny-rute, slik
// at klikk i selve sidemenyen (den normale måten å navigere på — i motsetning
// til nettleserens frem/tilbake-knapper) også gjenoppretter filtre/valg i
// stedet for å alltid gå til standardvisningen. sessionStorage (ikke
// localStorage) — skal ikke overleve på tvers av faner/økter, kun "husk
// hvor jeg var" innenfor denne besøksøkten.
// ---------------------------------------------------------------------------

const PREFIX = "nav_last:";

export function rememberCurrentUrl(pathname: string, search: string): void {
  try {
    const full = pathname + (search ? `?${search}` : "");
    sessionStorage.setItem(PREFIX + pathname, full);
  } catch {
    // sessionStorage utilgjengelig (privat modus e.l.) — bare hopp over
  }
}

/** Returnerer sist besøkte fulle URL for denne stien, eller stien selv
 *  uendret hvis ingenting er husket ennå. */
export function getRememberedUrl(pathname: string): string {
  try {
    return sessionStorage.getItem(PREFIX + pathname) ?? pathname;
  } catch {
    return pathname;
  }
}
