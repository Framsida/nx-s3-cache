// UT-5: cold-start validation of every environment variable (03, FN-5, FN-7).
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './config.js';

const valid = {
  BUCKET_NAME: 'nx-cache-prod-artifacts-111111111111',
  STS_REGION: 'eu-west-1',
  TOKEN_AUDIENCE: 'nx-cache.example.com',
  TOKEN_MAX_LIFETIME_SECONDS: '3600',
  MAX_ARTIFACT_BYTES: '4194304',
  ALLOWED_ROLES: '["111111111111:ci-runner","222222222222:AWSReservedSSO_Dev_0123abcd"]',
  ENVIRONMENT: 'prod',
  CACHE_ENABLED: 'true',
};

describe('parseConfig', () => {
  it('parses a complete configuration', () => {
    expect(parseConfig(valid)).toEqual({
      bucketName: valid.BUCKET_NAME,
      stsRegion: 'eu-west-1',
      tokenAudience: 'nx-cache.example.com',
      tokenMaxLifetimeSeconds: 3600,
      maxArtifactBytes: 4194304,
      allowedRoles: new Set(['111111111111:ci-runner', '222222222222:awsreservedsso_dev_0123abcd']),
      environment: 'prod',
      cacheEnabled: true,
    });
  });

  it('defaults the lifetime, size limit and cache switch', () => {
    const {
      TOKEN_MAX_LIFETIME_SECONDS: _a,
      MAX_ARTIFACT_BYTES: _b,
      CACHE_ENABLED: _c,
      ...rest
    } = valid;
    expect(parseConfig(rest)).toMatchObject({
      tokenMaxLifetimeSeconds: 3600,
      maxArtifactBytes: 4194304,
      cacheEnabled: true,
    });
  });

  it('turns the cache off with CACHE_ENABLED=false', () => {
    expect(parseConfig({ ...valid, CACHE_ENABLED: 'false' }).cacheEnabled).toBe(false);
  });

  it('has no setting that can change the STS host (08, IT-1)', () => {
    const config = parseConfig({
      ...valid,
      STS_ENDPOINT: 'https://evil.example',
      AWS_ENDPOINT_URL_STS: 'https://evil.example',
    });
    expect(Object.keys(config).sort()).toEqual([
      'allowedRoles',
      'bucketName',
      'cacheEnabled',
      'environment',
      'maxArtifactBytes',
      'stsRegion',
      'tokenAudience',
      'tokenMaxLifetimeSeconds',
    ]);
  });

  it.each([
    ['BUCKET_NAME', undefined, 'BUCKET_NAME is not set'],
    ['BUCKET_NAME', 'Upper-Case', 'not a valid S3 bucket name'],
    ['BUCKET_NAME', 'ab', 'not a valid S3 bucket name'],
    ['BUCKET_NAME', 'a..b-bucket', 'not a valid S3 bucket name'],
    ['BUCKET_NAME', 'xn--bucket', 'not a valid S3 bucket name'],
    ['STS_REGION', undefined, 'STS_REGION is not set'],
    ['STS_REGION', 'eu-west-1.evil.example', 'not an AWS region'],
    ['STS_REGION', 'EU-WEST-1', 'not an AWS region'],
    ['TOKEN_AUDIENCE', undefined, 'TOKEN_AUDIENCE is not set'],
    ['TOKEN_AUDIENCE', 'has space', 'printable ASCII'],
    ['TOKEN_MAX_LIFETIME_SECONDS', '899', 'between 900 and 43200'],
    ['TOKEN_MAX_LIFETIME_SECONDS', '43201', 'between 900 and 43200'],
    ['TOKEN_MAX_LIFETIME_SECONDS', '3600.5', 'must be an integer'],
    ['MAX_ARTIFACT_BYTES', '0', 'between 1 and 4500000'],
    ['MAX_ARTIFACT_BYTES', '4500001', 'between 1 and 4500000'],
    ['MAX_ARTIFACT_BYTES', 'lots', 'must be an integer'],
    ['ALLOWED_ROLES', undefined, 'ALLOWED_ROLES is not set'],
    ['ALLOWED_ROLES', 'not json', 'not valid JSON'],
    ['ALLOWED_ROLES', '[]', 'non-empty JSON array'],
    ['ALLOWED_ROLES', '["arn:aws:iam::111111111111:role/ci"]', 'is not "<account>:<role name>"'],
    ['ENVIRONMENT', undefined, 'ENVIRONMENT is not set'],
    ['ENVIRONMENT', 'Production', 'ENVIRONMENT must match'],
    ['CACHE_ENABLED', 'yes', 'CACHE_ENABLED must be "true" or "false"'],
  ])('rejects %s=%s', (name, value, message) => {
    const env: Record<string, string | undefined> = { ...valid, [name]: value };
    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(message);
  });
});
