export { RoutingEngineService, metricsHandler } from './service';
export type { RouteRequest, RouteResponse, SwapRoute, PoolInfo, MEVScanResult } from './types';
export { PathfindingEngine } from './pathfinding';
export { MEVRiskScanner } from './mev-scanner';
export { metricRegistry, requestCounter, latencyHistogram, getMetrics } from './metrics';
