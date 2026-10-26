// Shared constants and types for the bearer token (02 §3) and the cache's wire
// format (03 §2). Constants and types only (10, REPO-4): token creation lives in
// nx-s3-serverless-cache and validation in cache-handler.

/** Every token starts with this. A breaking format change needs a new prefix (10, DEL-5). */
export const TOKEN_PREFIX = 'nxcache-v1.';

/** Tokens longer than this are rejected before decoding (02, TOK-4). */
export const MAX_TOKEN_BYTES = 8192;

/** Signed header that binds a token to one deployment (02, TOK-1). */
export const AUDIENCE_HEADER = 'x-nx-cache-audience';

export const STS_SERVICE = 'sts';
export const STS_ACTION = 'GetCallerIdentity';
export const STS_VERSION = '2011-06-15';
export const SIGNING_ALGORITHM = 'AWS4-HMAC-SHA256';

/** The regional STS hostname is `${STS_HOSTNAME_PREFIX}<region>${STS_HOSTNAME_SUFFIX}` (02, TOK-2). */
export const STS_HOSTNAME_PREFIX = 'sts.';
export const STS_HOSTNAME_SUFFIX = '.amazonaws.com';

/** Query parameters a token's URL must carry (02 §3). */
export const REQUIRED_QUERY_PARAMETERS = [
  'Action',
  'Version',
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-SignedHeaders',
  'X-Amz-Signature',
] as const;

/** Present only for temporary credentials. */
export const OPTIONAL_QUERY_PARAMETERS = ['X-Amz-Security-Token'] as const;

export type TokenQueryParameter =
  (typeof REQUIRED_QUERY_PARAMETERS)[number] | (typeof OPTIONAL_QUERY_PARAMETERS)[number];

/** Default and maximum token lifetime, in seconds (02, TOK-3; 05, LT-1). */
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/** Regions of the `aws` partition, the only one supported (02, AUTHZ-5). */
export const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/** Workspace IDs (03, WS-1). */
export const WORKSPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Task hashes (01, CON-2). SPIKE-1 recorded 1 to 20 decimal digits (Nx's u64
 * task hash) on Nx 21.0.0 and 24.0.1. Letters are also allowed so custom task
 * hashers keep working; the alphabet still cannot express `/`, `.` or `%`.
 */
export const HASH_PATTERN = /^[A-Za-z0-9]{1,128}$/;

/** A hash that real builds never produce, used by `nx-s3-serverless-cache check` (05, CLI-3). */
export const PROBE_HASH = 'nxs3cacheprobe';

/**
 * Response header carrying what the handler did, because the HTTP status Nx
 * receives is chosen so that it never fails the build (03 §5.4, D-34).
 */
export const OUTCOME_HEADER = 'x-nx-cache-outcome';

/** Request outcomes, shared by logs (07, LOG-1) and the outcome header. */
export type Outcome =
  | 'hit'
  | 'miss'
  | 'stored'
  | 'exists'
  | 'oversize'
  | 'bad_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'upstream_error'
  | 'internal_error'
  | 'disabled';
