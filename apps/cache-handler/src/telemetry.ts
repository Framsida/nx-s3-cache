// One JSON line per request (07, LOG-1). The same line carries the request's
// CloudWatch metrics in Embedded Metric Format (07, MET-1), so there are no
// extra API calls and no second log line. It is written straight to stdout so
// Lambda's JSON log format passes it through unchanged.
import type { Outcome } from '@nx-s3-serverless-cache/token-format';

export const METRIC_NAMESPACE = 'NxCache';

export interface RequestRecord {
  requestId?: string;
  apiRequestId?: string;
  method?: string;
  workspace?: string;
  hash?: string;
  outcome: Outcome;
  status: number;
  /** Artifact size for `hit` and `stored`; declared size for `oversize`. */
  bytes?: number;
  durationMs: number;
  stsMs?: number;
  s3Ms?: number;
  principal?: string;
  session?: string;
  tokenHash8?: string;
  authCache?: 'hit' | 'miss';
  sourceIp?: string;
  userAgent?: string;
  errorCode?: string;
  awsRequestId?: string;
  /** Which dependency failed, for `upstream_error`. */
  upstream?: 'sts' | 's3';
  /** Why a request was rejected, in words. Never contains the token. */
  reason?: string;
  /**
   * True once the caller is an allowed role. Only then is the Workspace
   * dimension emitted, so unauthenticated callers cannot create metric series.
   */
  authorized: boolean;
}

type Unit = 'Count' | 'Bytes' | 'Milliseconds';

interface Metric {
  name: string;
  unit: Unit;
  value: number;
}

const COUNTERS: Partial<Record<Outcome, string>> = {
  hit: 'CacheHit',
  miss: 'CacheMiss',
  stored: 'Stored',
  exists: 'AlreadyExists',
  oversize: 'RejectedOversize',
  unauthenticated: 'Unauthenticated',
  forbidden: 'Forbidden',
  internal_error: 'InternalError',
};

function metricsFor(record: RequestRecord): Metric[] {
  const metrics: Metric[] = [];
  const counter = COUNTERS[record.outcome];
  if (counter) metrics.push({ name: counter, unit: 'Count', value: 1 });
  if (record.bytes !== undefined && ['hit', 'stored', 'oversize'].includes(record.outcome)) {
    metrics.push({ name: 'ArtifactBytes', unit: 'Bytes', value: record.bytes });
  }
  if (record.stsMs !== undefined)
    metrics.push({ name: 'StsLatency', unit: 'Milliseconds', value: record.stsMs });
  if (record.s3Ms !== undefined)
    metrics.push({ name: 'S3Latency', unit: 'Milliseconds', value: record.s3Ms });
  return metrics;
}

/** Builds the log line for a request. Exported for tests. */
export function formatRecord(
  record: RequestRecord,
  environment: string,
  now: number,
): Record<string, unknown> {
  const { authorized, upstream, ...fields } = record;
  const level =
    record.outcome === 'upstream_error' || record.outcome === 'internal_error' ? 'ERROR' : 'INFO';
  const line: Record<string, unknown> = {
    timestamp: new Date(now).toISOString(),
    level,
    message: `${record.method ?? '-'} ${record.outcome} ${record.status}`,
    ...fields,
    ...(upstream ? { upstream } : {}),
  };

  const withWorkspace = authorized && record.workspace !== undefined;
  const dimensions = withWorkspace
    ? [['Environment', 'Workspace'], ['Environment']]
    : [['Environment']];
  const directives: unknown[] = [];

  const metrics = metricsFor(record);
  if (metrics.length > 0) {
    directives.push({
      Namespace: METRIC_NAMESPACE,
      Dimensions: dimensions,
      Metrics: metrics.map((m) => ({ Name: m.name, Unit: m.unit })),
    });
    for (const m of metrics) line[m.name] = m.value;
  }
  if (record.outcome === 'upstream_error' && upstream) {
    directives.push({
      Namespace: METRIC_NAMESPACE,
      Dimensions: dimensions.map((d) => [...d, 'Upstream']),
      Metrics: [{ Name: 'UpstreamError', Unit: 'Count' }],
    });
    line.UpstreamError = 1;
    line.Upstream = upstream;
  }

  if (directives.length > 0) {
    line._aws = { Timestamp: now, CloudWatchMetrics: directives };
    line.Environment = environment;
    if (withWorkspace) line.Workspace = record.workspace;
  }
  return line;
}

export type Emit = (record: RequestRecord) => void;

export function stdoutEmitter(environment: string, now: () => number = Date.now): Emit {
  return (record) => {
    process.stdout.write(`${JSON.stringify(formatRecord(record, environment, now()))}\n`);
  };
}

/** For lines that are not about a request, such as the cold start (03, FN-1). */
export function logEvent(
  level: 'INFO' | 'ERROR',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields })}\n`,
  );
}
