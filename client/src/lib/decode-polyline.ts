// ---------------------------------------------------------------------------
// Google encoded polyline → [lat, lng][].
//
// Entur JP v3 returnerer leggenes geometri som `pointsOnLink.points`, kodet
// med Googles polyline-algoritme (presisjon 5). Dette er den kanoniske
// dekoderen (samme algoritme som @mapbox/polyline) — holdt som ~20 linjer her
// framfor en ekstra avhengighet.
//
// Algoritmen: hvert tall er zigzag-kodet (LSB = fortegn) og delta-kodet mot
// forrige verdi, i grupper på 5-bits-chunker med fortsettelses-bit (0x20).
// ---------------------------------------------------------------------------

export type LatLng = [number, number];

export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  if (!encoded) return [];
  const factor = Math.pow(10, precision);
  const coords: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const nextDelta = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63; // ASCII-offset
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    // zigzag → fortegnet heltall
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    lat += nextDelta();
    lng += nextDelta();
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}
