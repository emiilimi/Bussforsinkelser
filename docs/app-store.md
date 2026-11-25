# Sen Tur som app — utredning (2026-11-25)

## Kort svar

Ja, det går, men **ikke som en ren innpakning av nettsiden**. Apple avviser
apper som bare viser en nettside (App Review Guideline 4.2, «minimum
functionality»). Appen må gjøre noe nettsiden ikke kan. For Sen Tur finnes
det et naturlig kandidat-trekk: **varsel når du må dra** («Dra nå — T-bane 5
går om 6 min, og den har gått tidlig 1 av 20 dager»).

Anbefalt rekkefølge:

| Steg | Hva | Kostnad | Tid (ca.) |
|---|---|---|---|
| 1 | **PWA**: «Legg til på Hjem-skjerm» (manifest, ikoner, service worker for app-skallet). Fungerer på iPhone og Android uten butikk. | 0 kr | 1–2 dager |
| 2 | **Varsler i PWA-en** («dra nå»). iOS støtter web-push for PWA-er lagt på hjem-skjermen (iOS 16.4+); krever en liten server som sender varslene. | lav | 3–5 dager |
| 3 | **Butikk-app med Capacitor** — samme React-kode i et native skall, med lokale varsler, widget/hjem-skjerm-snarvei til «min vanlige reise». | Apple 99 USD/år, Google 25 USD én gang | 1–2 uker + godkjenning |

## Hvorfor PWA først

- Nesten all verdien (ikon på hjem-skjermen, fullskjerm, rask oppstart) for
  nesten null kostnad, og ingen godkjenningsrunde.
- Vi lærer om folk faktisk bruker den gjentatte ganger før vi betaler for
  butikkene.
- Mangler i dag: `manifest.webmanifest`, PNG-ikoner (192/512 + Apple touch
  icon), `theme-color`, og en service worker. Det kan jeg lage.

## Butikk-appen — det som må på plass

- **Utviklerkonto** i Emilies navn (Apple Developer Program, Google Play
  Console). Apple krever en Mac (eller sky-bygg som Codemagic/EAS) for å
  bygge og laste opp iOS-appen.
- **Personvernerklæring** (påkrevd i begge butikker) og Apples
  «privacy nutrition label». Sen Tur samler ikke inn persondata i dag, så
  den blir kort — men varsler krever at vi lagrer en push-token.
- **Native verdi** for å passere 4.2: lokale varsler «dra nå», widget med
  neste anbefalte avgang for en lagret reise, evt. Siri-/snarvei.
- **Ytelse**: DuckDB-WASM (~6 MB) i WKWebView er tungt på eldre iPhoner.
  Etter overgangs-, stopp- og linjefilene trengs DuckDB sjelden i den enkle
  visningen — appen bør bruke de ferdige filene og aldri starte DuckDB.
- **Entur-vilkår**: `ET-Client-Name` må fortsatt sendes; appen bør gå via
  vår egen proxy (som i dag), ikke direkte mot Entur fra telefonen.
- **Navn**: «Sen Tur» må sjekkes mot eksisterende apper/varemerker.

## Hva som gjør den appellerende (uavhengig av butikk)

Det som skiller Sen Tur fra Entur/Ruter/Skyss-appene er ett spørsmål:
**«Når må jeg dra for å rekke det — på en vanlig dag, eller når det er
viktig?»** En app bør åpne rett på svaret for brukerens vanlige reiser
(lagrede reiser + varsel), ikke på et søkeskjema.

## Beslutninger for Emilie

1. Skal jeg lage PWA-en nå (steg 1)? Det er trygt og kan ligge på preview.
2. Ønsker du butikk-app (steg 3) på sikt? Da trengs utviklerkontoer i ditt
   navn og en personvernerklæring.
