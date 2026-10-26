// Cold-start configuration (03, FN-5 and FN-7). Parsed once; any problem throws,
// so the cold start fails with one clear log line instead of failing requests.
import {
  DEFAULT_TOKEN_LIFETIME_SECONDS,
  REGION_PATTERN,
} from '@nx-s3-serverless-cache/token-format';
import { parseAllowedRoles } from './roles.js';

/** Hard ceiling on artifact size: base64 must fit a 6 MB Lambda payload (03, SIZE-1). */
export const ARTIFACT_BYTES_CEILING = 4_500_000;

export interface Config {
  bucketName: string;
  stsRegion: string;
  tokenAudience: string;
  tokenMaxLifetimeSeconds: number;
  maxArtifactBytes: number;
  /** Normalized `<account>:<lowercase role name>` keys (02, AUTHZ-2). */
  allowedRoles: ReadonlySet<string>;
  environment: string;
  /** False turns the cache off gracefully: every request is a miss or a skipped upload. */
  cacheEnabled: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const BUCKET_PATTERN =
  /^(?!xn--)(?!sthree-)(?!.*-s3alias$)(?!.*--ol-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const AUDIENCE_PATTERN = /^[\x21-\x7e]{1,253}$/;
const ENVIRONMENT_PATTERN = /^[a-z0-9-]{1,16}$/;

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new ConfigError(`${name} is not set`);
  return value;
}

function integer(env: Env, name: string, min: number, max: number, fallback?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${name} is not set`);
  }
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max)
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

export function parseConfig(env: Env): Config {
  const bucketName = required(env, 'BUCKET_NAME');
  if (!BUCKET_PATTERN.test(bucketName) || bucketName.includes('..')) {
    throw new ConfigError(`BUCKET_NAME is not a valid S3 bucket name: "${bucketName}"`);
  }

  const stsRegion = required(env, 'STS_REGION');
  if (!REGION_PATTERN.test(stsRegion))
    throw new ConfigError(`STS_REGION is not an AWS region: "${stsRegion}"`);

  const tokenAudience = required(env, 'TOKEN_AUDIENCE');
  if (!AUDIENCE_PATTERN.test(tokenAudience)) {
    throw new ConfigError(
      'TOKEN_AUDIENCE must be 1 to 253 printable ASCII characters without spaces',
    );
  }

  const environment = required(env, 'ENVIRONMENT');
  if (!ENVIRONMENT_PATTERN.test(environment)) {
    throw new ConfigError(`ENVIRONMENT must match ${ENVIRONMENT_PATTERN}, got "${environment}"`);
  }

  const rawRoles = required(env, 'ALLOWED_ROLES');
  let allowedRoles: ReadonlySet<string>;
  try {
    allowedRoles = parseAllowedRoles(JSON.parse(rawRoles));
  } catch (err) {
    throw new ConfigError(
      err instanceof SyntaxError ? 'ALLOWED_ROLES is not valid JSON' : (err as Error).message,
    );
  }

  const cacheEnabled = env.CACHE_ENABLED ?? 'true';
  if (cacheEnabled !== 'true' && cacheEnabled !== 'false') {
    throw new ConfigError(`CACHE_ENABLED must be "true" or "false", got "${cacheEnabled}"`);
  }

  return {
    bucketName,
    stsRegion,
    tokenAudience,
    tokenMaxLifetimeSeconds: integer(
      env,
      'TOKEN_MAX_LIFETIME_SECONDS',
      900,
      43_200,
      DEFAULT_TOKEN_LIFETIME_SECONDS,
    ),
    maxArtifactBytes: integer(
      env,
      'MAX_ARTIFACT_BYTES',
      1,
      ARTIFACT_BYTES_CEILING,
      4 * 1024 * 1024,
    ),
    allowedRoles,
    environment,
    cacheEnabled: cacheEnabled === 'true',
  };
}
