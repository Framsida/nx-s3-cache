// Lambda entry point for nx-cache-handler (03 §4).
import { S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { Authenticator } from './auth.js';
import { parseConfig, type Config } from './config.js';
import { createHandler } from './handler.js';
import { createSizeGate, isAuthorizerEvent } from './size-gate.js';
import { S3Storage } from './storage.js';
import { StsVerifier } from './sts.js';
import { logEvent, stdoutEmitter } from './telemetry.js';
import { RELEASE_VERSION } from './version.js';

function loadConfig(): Config {
  try {
    return parseConfig(process.env);
  } catch (err) {
    // Fail the cold start, not individual requests (03, FN-7).
    logEvent('ERROR', `Invalid configuration: ${(err as Error).message}`, {
      version: RELEASE_VERSION,
    });
    throw err;
  }
}

const config = loadConfig();

// Budget: STS 3 s plus two S3 attempts of at most 5 s stays inside the default
// 20 s function timeout, so the handler answers before Lambda gives up.
const s3 = new S3Client({
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
});

const emit = stdoutEmitter(config.environment);

const handleRequest = createHandler({
  config,
  authenticator: new Authenticator({
    region: config.stsRegion,
    maxLifetimeSeconds: config.tokenMaxLifetimeSeconds,
    verifier: new StsVerifier(config.tokenAudience),
  }),
  storage: new S3Storage(s3, config.bucketName),
  emit,
});

const sizeGate = createSizeGate(config, emit);

/** One function serves both the cache route and the PUT size gate (D-15, D-36). */
export const handler = (event: unknown, context: Context) =>
  isAuthorizerEvent(event)
    ? sizeGate(event, context)
    : handleRequest(event as APIGatewayProxyEvent, context);

logEvent('INFO', 'nx-cache-handler cold start', {
  version: RELEASE_VERSION,
  environment: config.environment,
  cacheEnabled: config.cacheEnabled,
  allowedRoleCount: config.allowedRoles.size,
  maxArtifactBytes: config.maxArtifactBytes,
});
