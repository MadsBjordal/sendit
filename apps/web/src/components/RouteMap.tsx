'use client';
import dynamic from 'next/dynamic';

export interface MapPoint {
  lat: number;
  lng: number;
  label: string;
  kind: 'pickup' | 'delivery' | 'vehicle';
}

/** Leaflet needs the browser: loaded only on the client. */
export const RouteMap = dynamic(() => import('./RouteMapInner').then((m) => m.RouteMapInner), {
  ssr: false,
  loading: () => <div className="h-full min-h-64 animate-pulse rounded-2xl bg-slate-200" />,
});
