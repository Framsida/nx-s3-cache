// The Nx plugin's preTasksExecution hook (05 §3). It runs once before every Nx
// command that runs tasks, mints a token and points Nx at the cache. It never
// breaks the build: any problem prints one line and turns the HTTP cache off
// for the run (05, PL-1).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CREDENTIALS_TIMEOUT_MS,
  credentialSource,
  describeCredentialError,
  resolveDefaultCredentials,
  withTimeout,
  type ResolveCredentials,
} from './credentials.js';
import { resolveOptions } from './options.js';
import { createToken } from './token.js';

export const SERVER_VARIABLE = 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER';
export const TOKEN_VARIABLE = 'NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN';
export const DISABLED_VARIABLE = 'NX_S3_SERVERLESS_CACHE_DISABLED';
/**
 * Fingerprint of the last token this plugin set. Nx before 22.7 keeps values
 * the hook set in the daemon's environment between commands (SPIKE-1, CQ-8),
 * so a token that is already set may be one of ours from an earlier command
 * rather than one supplied by the user (05, step 2).
 */
export const ISSUED_VARIABLE = 'NX_S3_SERVERLESS_CACHE_ISSUED';

/** The longest expected Nx command (D-21). */
const LONG_RUN_MS = 60 * 60 * 1000;

const PREFIX = '[nx-s3-serverless-cache]';

/** Remote caches Nx prefers over the HTTP cache (01, CB-2). */
const COMPETING_PACKAGES = [
  '@nx/s3-cache',
  '@nx/shared-fs-cache',
  '@nx/gcs-cache',
  '@nx/azure-cache',
  '@nx/powerpack-s3-cache',
  '@nx/powerpack-shared-fs-cache',
  '@nx/powerpack-gcs-cache',
  '@nx/powerpack-azure-cache',
];

export interface HookContext {
  workspaceRoot: string;
  nxJsonConfiguration?: Record<string, unknown>;
}

export interface HookDeps {
  resolveCredentials: ResolveCredentials;
  now: () => Date;
  /**
   * Read on every call: while the hook runs, Nx replaces process.env with a
   * proxy that records what the hook sets and copies it to the main process.
   */
  env: () => NodeJS.ProcessEnv;
  warn: (line: string) => void;
  info: (line: string) => void;
  exists: (path: string) => boolean;
}

export const defaultDeps: HookDeps = {
  resolveCredentials: resolveDefaultCredentials,
  now: () => new Date(),
  env: () => process.env,
  warn: (line) => console.warn(line),
  info: (line) => console.log(line),
  exists: existsSync,
};

export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Why Nx would ignore the HTTP cache in this workspace, if it would (05, CFG-2). */
export function competingCache(
  context: HookContext,
  env: NodeJS.ProcessEnv,
  exists: HookDeps['exists'],
): string | undefined {
  const nxJson = context.nxJsonConfiguration ?? {};
  const runners = Object.values(
    (nxJson.tasksRunnerOptions ?? {}) as Record<
      string,
      { runner?: string; options?: Record<string, unknown> }
    >,
  );
  const cloud =
    nxJson.neverConnectToCloud !== true &&
    env.NX_NO_CLOUD !== 'true' &&
    (Boolean(nxJson.nxCloudId) ||
      Boolean(nxJson.nxCloudAccessToken) ||
      Boolean(env.NX_CLOUD_ACCESS_TOKEN) ||
      runners.some(
        (r) =>
          r.runner === 'nx-cloud' ||
          r.runner === '@nrwl/nx-cloud' ||
          Boolean(r.options?.accessToken),
      ));
  if (cloud) return 'Nx Cloud is configured';
  const installed = COMPETING_PACKAGES.find((pkg) =>
    exists(join(context.workspaceRoot, 'node_modules', pkg, 'package.json')),
  );
  return installed ? `${installed} is installed` : undefined;
}

export function createPreTasksExecution(deps: HookDeps = defaultDeps) {
  return async function preTasksExecution(
    rawOptions: unknown,
    context: HookContext,
  ): Promise<void> {
    const env = deps.env();
    const verbose = env.NX_VERBOSE_LOGGING === 'true';

    // Step 1: opted out.
    if (env[DISABLED_VARIABLE] === 'true') return;

    // Step 2: a token supplied by CI or the user (made with the CLI) wins.
    const existing = env[TOKEN_VARIABLE];
    if (existing && env[ISSUED_VARIABLE] !== fingerprint(existing)) {
      if (verbose) deps.info(`${PREFIX} using the token already set in ${TOKEN_VARIABLE}`);
      return;
    }

    const disable = (message: string) => {
      deps.warn(`${PREFIX} Nx remote cache disabled: ${message}`);
      // An empty server turns the HTTP cache off for this run (SPIKE-1, CQ-9).
      env[SERVER_VARIABLE] = '';
      delete env[TOKEN_VARIABLE];
      delete env[ISSUED_VARIABLE];
    };

    const resolved = resolveOptions(rawOptions);
    if (!resolved.ok) return disable(`invalid plugin options in nx.json: ${resolved.error}`);
    const options = resolved.options;

    const competing = competingCache(context, env, deps.exists);
    if (competing) {
      deps.warn(
        `${PREFIX} ${competing}, so Nx will ignore nx-s3-serverless-cache. Remove it to use this cache.`,
      );
    }

    // Steps 3 and 4: credentials and token, within the time budget (05, PL-3).
    let token;
    let source;
    // One clock reading for signing and for the lifetime check, so a default
    // one-hour token does not look a few milliseconds short of an hour.
    const signedAt = deps.now();
    try {
      const work = (async () => {
        const credentials = await deps.resolveCredentials(options.profile);
        source = credentialSource(credentials, options.profile);
        return createToken({
          credentials,
          region: options.region,
          audience: options.audience,
          lifetimeSeconds: options.tokenLifetimeSeconds,
          now: signedAt,
        });
      })();
      token = await withTimeout(work, CREDENTIALS_TIMEOUT_MS);
    } catch (err) {
      return disable(describeCredentialError(err, options.profile));
    }

    // Step 5.
    env[SERVER_VARIABLE] = options.serverUrl;
    env[TOKEN_VARIABLE] = token.token;
    env[ISSUED_VARIABLE] = fingerprint(token.token);

    const lifetimeMs = token.expiresAt.getTime() - signedAt.getTime();
    if (lifetimeMs < LONG_RUN_MS) {
      const minutes = Math.max(0, Math.floor(lifetimeMs / 60_000));
      deps.warn(
        `${PREFIX} the cache token expires in ${minutes} min (${token.expiresAt.toISOString()}); ` +
          'the remote cache may stop working during long runs. Refresh your AWS credentials to get a full hour.',
      );
    }
    if (verbose) {
      // Never the token or the credentials (05, PL-5).
      deps.info(
        `${PREFIX} credentials: ${source}; region ${options.region}; workspace ${options.workspace}; ` +
          `token expires ${token.expiresAt.toISOString()}`,
      );
    }
  };
}
