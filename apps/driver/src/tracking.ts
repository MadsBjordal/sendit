import * as Location from 'expo-location';

export interface Fix {
  at: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  speedKmh: number | null;
}

/**
 * Follows the phone's position while the app is open and a job is active (foreground only:
 * nothing is tracked when the driver has no active job). Returns a stop function.
 */
export async function startTracking(onFix: (f: Fix) => void): Promise<(() => void) | null> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') return null;
  const sub = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Balanced, timeInterval: 30_000, distanceInterval: 100 },
    (p) =>
      onFix({
        at: new Date(p.timestamp).toISOString(),
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracyM: p.coords.accuracy ?? null,
        speedKmh: p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : null,
      }),
  );
  return () => {
    // expo-location's web build can throw when unsubscribing; stopping must never crash the app
    try {
      sub.remove();
    } catch {
      /* already stopped */
    }
  };
}

/** Above this speed the app refuses input (the driver must not use it while driving). */
export const MOVING_KMH = 10;
