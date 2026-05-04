import { createContext, useContext, useState, ReactNode } from "react";

export type Region =
  | "alle"
  | "sky"
  | "mor"
  | "inn"
  | "ost"
  | "rut"
  | "kol"
  | "vyg"
  | "tro"
  | "bra"
  | "fin"
  | "nor";

// Maps each region key to its NeTEx operator code (used to filter lineRef / API calls).
// Empty string = no filter (alle).
export const REGION_OPERATOR: Record<Region, string> = {
  alle: "",
  sky: "SKY",
  mor: "MOR",
  inn: "INN",
  ost: "OST",
  rut: "RUT",
  kol: "KOL",
  vyg: "VYG",
  tro: "TRO",
  bra: "BRA",
  fin: "FIN",
  nor: "NOR",
};

export const REGION_LABEL: Record<Region, string> = {
  alle: "Alle regioner",
  sky: "Skyss (Vestland)",
  mor: "Møre og Romsdal",
  inn: "Innlandet",
  ost: "Østfold",
  rut: "Ruter (Oslo/Akershus)",
  kol: "Kolumbus (Rogaland)",
  vyg: "Vy grønn",
  tro: "Troms",
  bra: "Brakar (Viken)",
  fin: "Finnmark",
  nor: "Nordland",
};

interface RegionContextType {
  region: Region;
  setRegion: (region: Region) => void;
  operator: string;
}

const STORAGE_KEY = "bussforsinkelser_region";

function getSavedRegion(): Region {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    // Migrate old keys (vestland→sky, oslo/viken→rut, rogaland→kol, trondelag→tro, agder→kol)
    const MIGRATE: Record<string, Region> = {
      vestland: "sky",
      oslo: "rut",
      viken: "rut",
      rogaland: "kol",
      trondelag: "tro",
      agder: "kol",
    };
    if (saved) {
      if (saved in REGION_OPERATOR) return saved as Region;
      if (saved in MIGRATE) return MIGRATE[saved];
    }
  } catch {
    // localStorage unavailable
  }
  return "sky";
}

const RegionContext = createContext<RegionContextType | undefined>(undefined);

export function RegionProvider({ children }: { children: ReactNode }) {
  const [region, setRegionState] = useState<Region>(getSavedRegion);

  const setRegion = (r: Region) => {
    setRegionState(r);
    try {
      localStorage.setItem(STORAGE_KEY, r);
    } catch {
      // ignore
    }
  };

  return (
    <RegionContext.Provider value={{ region, setRegion, operator: REGION_OPERATOR[region] }}>
      {children}
    </RegionContext.Provider>
  );
}

export function useRegion() {
  const context = useContext(RegionContext);
  if (!context) throw new Error("useRegion must be used within a RegionProvider");
  return context;
}
