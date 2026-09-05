export interface HealthStatus {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

/** Liveness snapshot for uptime checks (ARCHITECTURE.md §7). */
export function getHealthStatus(): HealthStatus {
  return {
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}
