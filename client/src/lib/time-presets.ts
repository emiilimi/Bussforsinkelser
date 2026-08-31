// Delt mellom Forsinkelseskart og Oversikt — samme inndeling av døgnet begge
// steder, slik at "Morgenrush (7–9)" betyr det samme uansett hvor du er.
export type TimePreset = { label: string; hourMin?: number; hourMax?: number };

export const TIME_PRESETS: TimePreset[] = [
  { label: "Hele dagen" },
  { label: "Morgenrush (7–9)", hourMin: 7, hourMax: 9 },
  { label: "Formiddag (9–15)", hourMin: 9, hourMax: 15 },
  { label: "Ettermiddagsrush (15–17)", hourMin: 15, hourMax: 17 },
  { label: "Ettermiddag (17–19)", hourMin: 17, hourMax: 19 },
  { label: "Kveld (19–23)", hourMin: 19, hourMax: 23 },
  { label: "Natt (23–4)", hourMin: 23, hourMax: 4 },
  { label: "Tidlig morgen (4–7)", hourMin: 4, hourMax: 7 },
];
