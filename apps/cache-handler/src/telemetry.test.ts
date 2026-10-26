// Log line and EMF metrics format (07, LOG-1 to LOG-3, MET-1).
import { describe, expect, it } from 'vitest';
import { formatRecord, type RequestRecord } from './telemetry.js';

const base: RequestRecord = {
  requestId: 'r1',
  apiRequestId: 'a1',
  method: 'GET',
  workspace: 'web',
  hash: '123',
  outcome: 'hit',
  status: 200,
  bytes: 1024,
  durationMs: 12,
  stsMs: 80,
  s3Ms: 9,
  principal: 'role:111111111111:ci-runner',
  session: 'build-7',
  tokenHash8: 'abcdef01',
  authCache: 'miss',
  authorized: true,
};

const NOW = Date.UTC(2026, 9, 26);

describe('formatRecord', () => {
  it('writes LOG-1 fields and EMF metrics with workspace dimensions', () => {
    const line = formatRecord(base, 'prod', NOW);
    expect(line).toMatchObject({
      timestamp: '2026-10-26T00:00:00.000Z',
      level: 'INFO',
      requestId: 'r1',
      apiRequestId: 'a1',
      method: 'GET',
      workspace: 'web',
      hash: '123',
      outcome: 'hit',
      status: 200,
      bytes: 1024,
      principal: 'role:111111111111:ci-runner',
      session: 'build-7',
      tokenHash8: 'abcdef01',
      authCache: 'miss',
      Environment: 'prod',
      Workspace: 'web',
      CacheHit: 1,
      ArtifactBytes: 1024,
      StsLatency: 80,
      S3Latency: 9,
      _aws: {
        Timestamp: NOW,
        CloudWatchMetrics: [
          {
            Namespace: 'NxCache',
            Dimensions: [['Environment', 'Workspace'], ['Environment']],
            Metrics: [
              { Name: 'CacheHit', Unit: 'Count' },
              { Name: 'ArtifactBytes', Unit: 'Bytes' },
              { Name: 'StsLatency', Unit: 'Milliseconds' },
              { Name: 'S3Latency', Unit: 'Milliseconds' },
            ],
          },
        ],
      },
    });
    expect(line).not.toHaveProperty('authorized');
  });

  it('omits the Workspace dimension before authorization, so callers cannot create series', () => {
    const line = formatRecord(
      {
        ...base,
        outcome: 'forbidden',
        status: 404,
        authorized: false,
        bytes: undefined,
        s3Ms: undefined,
      },
      'prod',
      NOW,
    );
    expect(line).not.toHaveProperty('Workspace');
    expect(line).toMatchObject({
      Forbidden: 1,
      _aws: { CloudWatchMetrics: [{ Dimensions: [['Environment']] }] },
    });
  });

  it('logs upstream errors at ERROR with an Upstream dimension (LOG-3)', () => {
    const line = formatRecord(
      {
        ...base,
        outcome: 'upstream_error',
        status: 404,
        upstream: 's3',
        errorCode: 'SlowDown',
        awsRequestId: 's3-1',
        bytes: undefined,
      },
      'prod',
      NOW,
    );
    expect(line).toMatchObject({
      level: 'ERROR',
      errorCode: 'SlowDown',
      awsRequestId: 's3-1',
      upstream: 's3',
      Upstream: 's3',
      UpstreamError: 1,
    });
    const directives = (
      line._aws as {
        CloudWatchMetrics: Array<{ Dimensions: string[][]; Metrics: Array<{ Name: string }> }>;
      }
    ).CloudWatchMetrics;
    expect(directives[1]).toEqual({
      Namespace: 'NxCache',
      Dimensions: [
        ['Environment', 'Workspace', 'Upstream'],
        ['Environment', 'Upstream'],
      ],
      Metrics: [{ Name: 'UpstreamError', Unit: 'Count' }],
    });
  });

  it('records the declared size of an oversize upload', () => {
    const line = formatRecord(
      {
        ...base,
        method: 'PUT',
        outcome: 'oversize',
        status: 403,
        bytes: 7_000_000,
        authorized: false,
      },
      'prod',
      NOW,
    );
    expect(line).toMatchObject({ RejectedOversize: 1, ArtifactBytes: 7_000_000 });
  });

  it('writes a plain log line when there is no metric', () => {
    const line = formatRecord(
      {
        outcome: 'bad_request',
        status: 404,
        durationMs: 1,
        authorized: false,
        reason: 'unknown route',
      },
      'prod',
      NOW,
    );
    expect(line).not.toHaveProperty('_aws');
    expect(line).toMatchObject({ level: 'INFO', outcome: 'bad_request', reason: 'unknown route' });
  });
});
