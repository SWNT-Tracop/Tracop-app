/** Readiness facts for GET /ready and the metrics endpoint. */
export interface OperationsProbe {
  /** True when the database answers. */
  databaseReachable(): Promise<boolean>;
  /** The newest worker heartbeat, or null when no worker ever beat. */
  latestHeartbeat(): Promise<Date | null>;
  /** Records this worker process as alive. */
  beat(workerId: string, at: Date): Promise<void>;
}

export const OPERATIONS_PROBE = Symbol('OPERATIONS_PROBE');
export const HTTP_METRICS = Symbol('HTTP_METRICS');
