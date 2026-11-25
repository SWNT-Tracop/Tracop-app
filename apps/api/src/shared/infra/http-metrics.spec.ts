import { HttpMetrics } from './http-metrics.js';

const seriesOf = (text: string, prefix: string) =>
  text.split('\n').filter((line) => line.startsWith(prefix));

describe('HttpMetrics', () => {
  it('renders counters and durations sorted by their labels, whatever the insertion order or values', () => {
    const metrics = new HttpMetrics();
    // Keys whose text order differs from "key,count" order: a sort without a comparator would
    // compare "GET|/b|200,10" with "GET|/b|2000,1".
    for (let index = 0; index < 10; index += 1) metrics.record('GET', '/b', 200, 5);
    metrics.record('GET', '/b', 2000, 7);
    metrics.record('POST', '/a', 201, 3);
    metrics.record('GET', '/a', 404, 1);
    const text = metrics.render({ tracop_outbox_pending: 4 });
    expect(seriesOf(text, 'tracop_http_requests_total{')).toEqual([
      'tracop_http_requests_total{method="GET",route="/a",status="404"} 1',
      'tracop_http_requests_total{method="GET",route="/b",status="200"} 10',
      'tracop_http_requests_total{method="GET",route="/b",status="2000"} 1',
      'tracop_http_requests_total{method="POST",route="/a",status="201"} 1',
    ]);
    expect(seriesOf(text, 'tracop_http_request_duration_ms_count{')).toEqual([
      'tracop_http_request_duration_ms_count{method="GET",route="/a"} 1',
      'tracop_http_request_duration_ms_count{method="GET",route="/b"} 11',
      'tracop_http_request_duration_ms_count{method="POST",route="/a"} 1',
    ]);
    expect(seriesOf(text, 'tracop_http_request_duration_ms_sum{method="GET",route="/b"}')).toEqual([
      'tracop_http_request_duration_ms_sum{method="GET",route="/b"} 57',
    ]);
    expect(text.split('\n')).toContain('tracop_outbox_pending 4');
  });

  it('escapes quotes, backslashes and new lines in label values', () => {
    const metrics = new HttpMetrics();
    metrics.record('GET', 'a"b\\c\nd', 200, 1);
    expect(metrics.render({})).toContain('route="a\\"b\\\\c d"');
  });
});
