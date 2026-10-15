import { estimateRoute, type LatLng, type RouteEstimate } from '@freight/shared';

/**
 * Routing plug point. Only the straight-line estimate exists today: it is labelled
 * "straight_line_estimate" on every shipment and is NOT a truck route (no truck restrictions,
 * no transit countries). A commercial truck-routing provider replaces it (DECISIONS.md D-010).
 */
export interface RoutingProvider {
  route(from: LatLng, to: LatLng): Promise<RouteEstimate>;
}

export class EstimateRouting implements RoutingProvider {
  async route(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    return estimateRoute(from, to);
  }
}
