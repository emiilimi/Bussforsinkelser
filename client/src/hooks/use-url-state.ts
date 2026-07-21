import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";

/**
 * Synkroniserer ett enkelt stykke UI-state med en URL-query-parameter, slik
 * at valget består når man navigerer bort (f.eks. til et annet menypunkt)
 * og tilbake — uten at man må huske hva man så på sist.
 *
 * Skriver med `replace: true` (ingen ekstra history-innslag per endring —
 * "tilbake" i nettleseren skal ikke måtte klikkes seg gjennom hver eneste
 * filterendring). Fjerner parameteren helt fra URL-en når verdien er lik
 * defaultValue, slik at URL-en holder seg ren når man ikke har avveket fra
 * standardvisningen.
 */
export function useUrlParam(key: string, defaultValue: string): [string, (v: string) => void] {
  const search = useSearch();
  const [location, navigate] = useLocation();

  const value = useMemo(() => {
    const params = new URLSearchParams(search);
    return params.get(key) ?? defaultValue;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, key]);

  const setValue = useCallback((next: string) => {
    const params = new URLSearchParams(search);
    if (next === defaultValue || next === "") params.delete(key);
    else params.set(key, next);
    const qs = params.toString();
    navigate(`${location}${qs ? `?${qs}` : ""}`, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, location, key, defaultValue]);

  return [value, setValue];
}
