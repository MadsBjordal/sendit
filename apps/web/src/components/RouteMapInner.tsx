'use client';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import type { MapPoint } from './RouteMap';

const COLORS = { pickup: '#2563eb', delivery: '#059669', vehicle: '#64748b' };

function Fit({ points }: { points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) map.setView([50.5, 10], 4);
    else if (points.length === 1) map.setView([points[0]!.lat, points[0]!.lng], 7);
    else
      map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), {
        padding: [40, 40],
      });
  }, [map, points]);
  return null;
}

/**
 * The line between pickup and delivery is drawn straight on purpose: no truck route is known
 * until a commercial truck-routing provider is connected.
 */
export function RouteMapInner({ points, height = 320 }: { points: MapPoint[]; height?: number }) {
  const pickup = points.find((p) => p.kind === 'pickup');
  const delivery = points.find((p) => p.kind === 'delivery');
  return (
    <div style={{ height }}>
      <MapContainer
        center={[50.5, 10]}
        zoom={4}
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {pickup && delivery && (
          <Polyline
            positions={[
              [pickup.lat, pickup.lng],
              [delivery.lat, delivery.lng],
            ]}
            pathOptions={{ color: '#2563eb', dashArray: '6 8', weight: 3 }}
          />
        )}
        {points.map((p, i) => (
          <CircleMarker
            key={i}
            center={[p.lat, p.lng]}
            radius={p.kind === 'vehicle' ? 6 : 9}
            pathOptions={{ color: 'white', weight: 2, fillColor: COLORS[p.kind], fillOpacity: 1 }}
          >
            <Tooltip>{p.label}</Tooltip>
          </CircleMarker>
        ))}
        <Fit points={points} />
      </MapContainer>
    </div>
  );
}
