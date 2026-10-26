// UT-7 (plugin): steps 1 to 5 of 05 §3 and PL-1 to PL-5.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  competingCache,
  createPreTasksExecution,
  DISABLED_VARIABLE,
  fingerprint,
  ISSUED_VARIABLE,
  SERVER_VARIABLE,
  TOKEN_VARIABLE,
  type HookDeps,
} from './plugin.js';

const NOW = new Date(Date.UTC(2026, 9, 26, 9, 0, 0));
const credentials = {
  accessKeyId: 'ASIAEXAMPLE',
  secretAccessKey: 'super-secret-key',
  sessionToken: 'session-token',
  expiration: new Date(NOW.getTime() + 8 * 3600_000),
};
const options = {
  url: 'https://nx-cache.example.com',
  workspace: 'web-platform',
  region: 'eu-west-1',
};
const context = { workspaceRoot: '/repo', nxJsonConfiguration: {} };

function setup(overrides: Partial<HookDeps> = {}, initialEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...initialEnv };
  const warn = vi.fn<(line: string) => void>();
  const info = vi.fn<(line: string) => void>();
  const resolveCredentials = vi.fn<HookDeps['resolveCredentials']>(async () => credentials);
  const hook = createPreTasksExecution({
    resolveCredentials,
    now: () => NOW,
    env: () => env,
    warn,
    info,
    exists: () => false,
    ...overrides,
  });
  return { hook, env, warn, info, resolveCredentials };
}

function decodedUrl(token: string | undefined): URL {
  return new URL(Buffer.from(token!.slice('nxcache-v1.'.length), 'base64url').toString());
}

afterEach(() => {
  vi.useRealTimers();
});

describe('step 1: opt-out', () => {
  it(`does nothing when ${DISABLED_VARIABLE}=true`, async () => {
    const { hook, env, resolveCredentials, warn } = setup({}, { [DISABLED_VARIABLE]: 'true' });
    await hook(options, context);
    expect(env).toEqual({ [DISABLED_VARIABLE]: 'true' });
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('step 2: a token that is already set', () => {
  it('keeps a token supplied by the user or CI', async () => {
    const { hook, env, resolveCredentials } = setup({}, { [TOKEN_VARIABLE]: 'nxcache-v1.from-ci' });
    await hook(options, context);
    expect(env[TOKEN_VARIABLE]).toBe('nxcache-v1.from-ci');
    expect(env[SERVER_VARIABLE]).toBeUndefined();
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it('replaces a token it set itself in an earlier command (daemon before Nx 22.7)', async () => {
    const stale = 'nxcache-v1.stale';
    const { hook, env, resolveCredentials } = setup(
      {},
      { [TOKEN_VARIABLE]: stale, [ISSUED_VARIABLE]: fingerprint(stale) },
    );
    await hook(options, context);
    expect(resolveCredentials).toHaveBeenCalledOnce();
    expect(env[TOKEN_VARIABLE]).not.toBe(stale);
    expect(env[ISSUED_VARIABLE]).toBe(fingerprint(env[TOKEN_VARIABLE]!));
  });

  it('keeps a user token even when an old marker is left over', async () => {
    const { hook, env } = setup(
      {},
      { [TOKEN_VARIABLE]: 'nxcache-v1.user', [ISSUED_VARIABLE]: fingerprint('nxcache-v1.old') },
    );
    await hook(options, context);
    expect(env[TOKEN_VARIABLE]).toBe('nxcache-v1.user');
  });
});

describe('steps 3 to 5: token and server', () => {
  it('sets the server URL and a token for the deployment region and audience', async () => {
    const { hook, env, resolveCredentials, warn } = setup();
    await hook(options, context);
    expect(resolveCredentials).toHaveBeenCalledWith(undefined);
    expect(env[SERVER_VARIABLE]).toBe('https://nx-cache.example.com/web-platform');
    const url = decodedUrl(env[TOKEN_VARIABLE]);
    expect(url.host).toBe('sts.eu-west-1.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host;x-nx-cache-audience');
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the profile and token lifetime from the options', async () => {
    const { hook, env, resolveCredentials } = setup();
    await hook({ ...options, profile: 'nx-cache', tokenLifetimeSeconds: 7200 }, context);
    expect(resolveCredentials).toHaveBeenCalledWith('nx-cache');
    expect(decodedUrl(env[TOKEN_VARIABLE]).searchParams.get('X-Amz-Expires')).toBe('7200');
  });

  it('strips a trailing slash from the url (SPIKE-1, CQ-3)', async () => {
    const { hook, env } = setup();
    await hook({ ...options, url: 'https://nx-cache.example.com/' }, context);
    expect(env[SERVER_VARIABLE]).toBe('https://nx-cache.example.com/web-platform');
  });
});

describe('PL-1 and PL-2: never break the build', () => {
  it.each([
    [
      'no credentials',
      new Error('Could not load credentials from any providers'),
      'no AWS credentials found. Run "aws sso login --profile nx-cache".',
    ],
    [
      'an expired SSO session',
      new Error('The SSO session associated with this profile has expired or is otherwise invalid'),
      'your AWS SSO session has expired. Run "aws sso login --profile nx-cache".',
    ],
    [
      'another error',
      new Error('EACCES: permission denied, open ~/.aws/config'),
      'could not get AWS credentials (EACCES: permission denied, open ~/.aws/config).',
    ],
  ])('turns the cache off with one warning on %s', async (_name, error, message) => {
    const { hook, env, warn } = setup({ resolveCredentials: async () => Promise.reject(error) });
    await hook({ ...options, profile: 'nx-cache' }, context);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      `[nx-s3-serverless-cache] Nx remote cache disabled: ${message}`,
    );
    expect(env[SERVER_VARIABLE]).toBe('');
    expect(env[TOKEN_VARIABLE]).toBeUndefined();
  });

  it.each([
    ['no url', { workspace: 'w', region: 'eu-west-1' }, '"url" is required'],
    ['a bad workspace', { ...options, workspace: 'Web_Platform' }, '"workspace" must be'],
    ['a bad region', { ...options, region: 'Ireland' }, '"region" must be an AWS region'],
    ['no options at all', undefined, '"url" is required'],
  ])('turns the cache off with one line on %s (05, CFG-1)', async (_name, raw, message) => {
    const { hook, env, warn, resolveCredentials } = setup();
    await hook(raw, context);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(message);
    expect(env[SERVER_VARIABLE]).toBe('');
    expect(resolveCredentials).not.toHaveBeenCalled();
  });

  it('gives up on credentials after 5 seconds (05, PL-3)', async () => {
    vi.useFakeTimers();
    const { hook, env, warn } = setup({ resolveCredentials: () => new Promise(() => {}) });
    const run = hook(options, context);
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    expect(warn).toHaveBeenCalledWith(
      '[nx-s3-serverless-cache] Nx remote cache disabled: AWS credentials took longer than 5 s to resolve.',
    );
    expect(env[SERVER_VARIABLE]).toBe('');
  });
});

describe('PL-4: short-lived tokens', () => {
  it('warns when the credentials expire within the hour, and still sets the token', async () => {
    const soon = { ...credentials, expiration: new Date(NOW.getTime() + 25 * 60_000) };
    const { hook, env, warn } = setup({ resolveCredentials: async () => soon });
    await hook(options, context);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('expires in 25 min');
    expect(env[TOKEN_VARIABLE]).toBeDefined();
    expect(env[SERVER_VARIABLE]).toBe('https://nx-cache.example.com/web-platform');
  });

  it('does not warn for the default one-hour token while the clock moves on', async () => {
    let t = NOW.getTime();
    const { hook, warn } = setup({ now: () => new Date((t += 7)) });
    await hook(options, context);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the configured lifetime is under an hour', async () => {
    const { hook, warn } = setup();
    await hook({ ...options, tokenLifetimeSeconds: 900 }, context);
    expect(warn.mock.calls[0]?.[0]).toContain('expires in 15 min');
  });
});

describe('PL-5: verbose logging', () => {
  it('logs the source, region, workspace and expiry, never the token or secrets', async () => {
    const { hook, env, info } = setup({}, { NX_VERBOSE_LOGGING: 'true' });
    await hook(options, context);
    expect(info).toHaveBeenCalledOnce();
    const line = info.mock.calls[0]![0];
    expect(line).toContain('region eu-west-1');
    expect(line).toContain('workspace web-platform');
    expect(line).toContain('2026-10-26T10:00:00.000Z');
    expect(line).not.toContain(env[TOKEN_VARIABLE]!.slice(11, 40));
    expect(line).not.toContain(credentials.secretAccessKey);
    expect(line).not.toContain(credentials.sessionToken);
  });

  it('logs nothing without NX_VERBOSE_LOGGING', async () => {
    const { hook, info } = setup();
    await hook(options, context);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('CFG-2: caches Nx would prefer', () => {
  const env = {};
  const none = () => false;

  it.each([
    ['an Nx Cloud ID', { nxCloudId: 'abc' }],
    ['an Nx Cloud access token', { nxCloudAccessToken: 'abc' }],
    ['the legacy nx-cloud runner', { tasksRunnerOptions: { default: { runner: 'nx-cloud' } } }],
  ])('detects %s', (_name, nxJson) => {
    expect(competingCache({ workspaceRoot: '/repo', nxJsonConfiguration: nxJson }, env, none)).toBe(
      'Nx Cloud is configured',
    );
  });

  it('ignores Nx Cloud when the workspace opts out', () => {
    expect(
      competingCache(
        {
          workspaceRoot: '/repo',
          nxJsonConfiguration: { nxCloudId: 'abc', neverConnectToCloud: true },
        },
        env,
        none,
      ),
    ).toBeUndefined();
    expect(
      competingCache(
        { workspaceRoot: '/repo', nxJsonConfiguration: { nxCloudId: 'abc' } },
        { NX_NO_CLOUD: 'true' },
        none,
      ),
    ).toBeUndefined();
  });

  it('detects an installed @nx cache package', () => {
    const exists = (p: string) => p === '/repo/node_modules/@nx/s3-cache/package.json';
    expect(competingCache({ workspaceRoot: '/repo' }, env, exists)).toBe(
      '@nx/s3-cache is installed',
    );
  });

  it('warns from the hook and still sets the token', async () => {
    const { hook, env: hookEnv, warn } = setup();
    await hook(options, { workspaceRoot: '/repo', nxJsonConfiguration: { nxCloudId: 'abc' } });
    expect(warn.mock.calls[0]?.[0]).toContain(
      'Nx Cloud is configured, so Nx will ignore nx-s3-serverless-cache',
    );
    expect(hookEnv[TOKEN_VARIABLE]).toBeDefined();
  });
});
