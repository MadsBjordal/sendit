export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A rough road-distance estimate used ONLY until a commercial truck-routing provider is connected.
 * It is labelled "estimated" everywhere it is shown and must never be presented as a truck route.
 */
export const ROAD_FACTOR = 1.25;
export const ESTIMATE_TRUCK_KMH = 65;

export interface RouteEstimate {
  distanceKm: number;
  durationMinutes: number;
  source: 'straight_line_estimate' | 'truck_routing';
  /** Countries the route passes through between origin and destination, when the provider knows them */
  transitCountries: string[] | null;
}

export function estimateRoute(from: LatLng, to: LatLng): RouteEstimate {
  const km = Math.max(1, Math.round(haversineKm(from, to) * ROAD_FACTOR));
  return {
    distanceKm: km,
    durationMinutes: Math.round((km / ESTIMATE_TRUCK_KMH) * 60),
    source: 'straight_line_estimate',
    transitCountries: null,
  };
}
