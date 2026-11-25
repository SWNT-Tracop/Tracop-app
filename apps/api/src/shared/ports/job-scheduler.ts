export interface ScheduledJob {
  /** Stable queue name, e.g. 'catalog.expire-lots'. */
  readonly name: string;
  /** Five-field cron expression evaluated in UTC. */
  readonly cron: string;
  /** Seconds before a run is considered stuck and retried. */
  readonly timeoutSeconds: number;
  /** Retries after a failed run before waiting for the next schedule. */
  readonly retryLimit: number;
  /** Must be idempotent: a run may repeat after a timeout or a crash. */
  run(): Promise<unknown>;
}

export interface JobSchedulerPort {
  start(): Promise<void>;
  /** Waits for running jobs to finish (bounded) and releases connections. */
  stop(): Promise<void>;
  schedule(job: ScheduledJob): Promise<void>;
  registered(): readonly string[];
}

export const JOB_SCHEDULER = Symbol('JOB_SCHEDULER');
