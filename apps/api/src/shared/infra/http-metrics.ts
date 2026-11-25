/**
 * Request counters and durations in memory, rendered in the Prometheus text format. Labels are
 * the method, the route template (never the concrete path, which may carry ids) and the status.
 */
/** Orders [key, value] entries by key only, so the output never depends on the values. */
const byKey = <T>([left]: [string, T], [right]: [string, T]): number =>
  left < right ? -1 : left > right ? 1 : 0;

export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, { sum: number; count: number }>();
  private readonly startedAt = Date.now();

  record(method: string, route: string, status: number, durationMs: number): void {
    const key = `${method}|${route}|${status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const durationKey = `${method}|${route}`;
    const duration = this.durations.get(durationKey) ?? { sum: 0, count: 0 };
    duration.sum += durationMs;
    duration.count += 1;
    this.durations.set(durationKey, duration);
  }

  render(extra: Readonly<Record<string, number>>): string {
    const label = (value: string) =>
      value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
    const lines = [
      '# HELP tracop_http_requests_total HTTP requests by method, route template and status.',
      '# TYPE tracop_http_requests_total counter',
      ...[...this.requests].sort(byKey).map(([key, count]) => {
        const [method, route, status] = key.split('|') as [string, string, string];
        return `tracop_http_requests_total{method="${label(method)}",route="${label(route)}",status="${status}"} ${count}`;
      }),
      '# HELP tracop_http_request_duration_ms HTTP request duration in milliseconds.',
      '# TYPE tracop_http_request_duration_ms summary',
      ...[...this.durations].sort(byKey).flatMap(([key, { sum, count }]) => {
        const [method, route] = key.split('|') as [string, string];
        const labels = `method="${label(method)}",route="${label(route)}"`;
        return [
          `tracop_http_request_duration_ms_sum{${labels}} ${Math.round(sum)}`,
          `tracop_http_request_duration_ms_count{${labels}} ${count}`,
        ];
      }),
      '# HELP tracop_process_uptime_seconds Seconds since this API process started.',
      '# TYPE tracop_process_uptime_seconds gauge',
      `tracop_process_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
      '# HELP tracop_process_resident_memory_bytes Resident memory of this API process.',
      '# TYPE tracop_process_resident_memory_bytes gauge',
      `tracop_process_resident_memory_bytes ${process.memoryUsage().rss}`,
      ...Object.entries(extra).flatMap(([name, value]) => [
        `# TYPE ${name} gauge`,
        `${name} ${value}`,
      ]),
    ];
    return `${lines.join('\n')}\n`;
  }
}
