// UT-7 (CLI): CLI-1 to CLI-4.
import { describe, expect, it, vi } from 'vitest';
import { EXIT, runCli, type CliDeps } from './cli-main.js';
import { stripJsonc } from './nx-json.js';

const NOW = new Date(Date.UTC(2026, 9, 26, 9, 0, 0));
const credentials = {
  accessKeyId: 'ASIAEXAMPLE',
  secretAccessKey: 'secret',
  sessionToken: 'session',
};

const NX_JSON = `{
  // nx.json may have comments
  "plugins": [
    "@nx/js",
    {
      "plugin": "nx-s3-serverless-cache",
      "options": {
        "url": "https://nx-cache.example.com", /* base URL */
        "workspace": "web-platform",
        "region": "eu-west-1",
      },
    },
  ],
}`;

function setup(
  overrides: Partial<CliDeps> = {},
  files: Record<string, string> = { '/repo/nx.json': NX_JSON },
) {
  const out: string[] = [];
  const err: string[] = [];
  const fetch = vi.fn(
    async () => new Response(null, { status: 404, headers: { 'x-nx-cache-outcome': 'miss' } }),
  );
  const deps: CliDeps = {
    cwd: '/repo/apps/web',
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    resolveCredentials: async () => credentials,
    now: () => NOW,
    fetch: fetch as unknown as typeof globalThis.fetch,
    readFile: (path) => files[path],
    version: '1.2.3',
    ...overrides,
  };
  return { run: (...argv: string[]) => runCli(argv, deps), out, err, fetch };
}

const tokenUrl = (token: string) =>
  new URL(Buffer.from(token.slice('nxcache-v1.'.length), 'base64url').toString());

describe('token', () => {
  it('prints the bare token by default, with options from the nearest nx.json (CLI-1, CLI-2)', async () => {
    const { run, out } = setup();
    expect(await run('token')).toBe(EXIT.ok);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^nxcache-v1\.[A-Za-z0-9_-]+$/);
    expect(tokenUrl(out[0]!).host).toBe('sts.eu-west-1.amazonaws.com');
  });

  it('prints export lines for both Nx variables with --format env', async () => {
    const { run, out } = setup();
    expect(await run('token', '--format', 'env')).toBe(EXIT.ok);
    expect(out[0]).toBe(
      "export NX_SELF_HOSTED_REMOTE_CACHE_SERVER='https://nx-cache.example.com/web-platform'",
    );
    expect(out[1]).toMatch(
      /^export NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN='nxcache-v1\.[A-Za-z0-9_-]+'$/,
    );
  });

  it('prints the token, server and expiry with --format json', async () => {
    const { run, out } = setup();
    await run('token', '--format', 'json');
    expect(JSON.parse(out[0]!)).toEqual({
      token: expect.stringMatching(/^nxcache-v1\./),
      server: 'https://nx-cache.example.com/web-platform',
      expiresAt: '2026-10-26T10:00:00.000Z',
    });
  });

  it('lets flags override nx.json', async () => {
    const { run, out } = setup();
    await run(
      'token',
      '--format',
      'json',
      '--workspace',
      'mobile',
      '--region',
      'us-east-1',
      '--lifetime',
      '900',
    );
    const json = JSON.parse(out[0]!);
    expect(json.server).toBe('https://nx-cache.example.com/mobile');
    expect(tokenUrl(json.token).host).toBe('sts.us-east-1.amazonaws.com');
    expect(tokenUrl(json.token).searchParams.get('X-Amz-Expires')).toBe('900');
  });

  it('works from flags alone when there is no nx.json', async () => {
    const { run } = setup({}, {});
    expect(
      await run(
        'token',
        '--url',
        'https://c.example.com',
        '--workspace',
        'w',
        '--region',
        'eu-west-1',
      ),
    ).toBe(EXIT.ok);
  });

  it('passes the profile to the credential chain', async () => {
    const resolveCredentials = vi.fn(async () => credentials);
    const { run } = setup({ resolveCredentials });
    await run('token', '--profile', 'nx-cache');
    expect(resolveCredentials).toHaveBeenCalledWith('nx-cache');
  });
});

describe('exit codes (CLI-4)', () => {
  it('exits 1 without credentials', async () => {
    const { run, err } = setup({
      resolveCredentials: async () =>
        Promise.reject(new Error('Could not load credentials from any providers')),
    });
    expect(await run('token')).toBe(EXIT.credentials);
    expect(err[0]).toBe('error: no AWS credentials found. Run "aws sso login".');
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['login']],
    ['an extra argument', ['token', 'extra']],
    ['an unknown flag', ['token', '--colour']],
    ['an unknown format', ['token', '--format', 'yaml']],
    ['--format on check', ['check', '--format', 'json']],
  ])('exits 2 on %s', async (_name, argv) => {
    const { run } = setup();
    expect(await run(...argv)).toBe(EXIT.config);
  });

  it('exits 2 when options are missing, and says where defaults came from', async () => {
    const { run, err } = setup({}, {});
    expect(await run('token')).toBe(EXIT.config);
    expect(err[0]).toContain('no nx.json found');
  });

  it('exits 2 on an nx.json that is not JSON', async () => {
    const { run, err } = setup({}, { '/repo/nx.json': '{ nope' });
    expect(await run('check')).toBe(EXIT.config);
    expect(err[0]).toContain('/repo/nx.json is not valid JSON');
  });

  it('prints usage with --help and the version with --version', async () => {
    const { run, out } = setup();
    expect(await run('--help')).toBe(EXIT.ok);
    expect(out[0]).toContain('nx-s3-serverless-cache check');
    expect(await run('--version')).toBe(EXIT.ok);
    expect(out[1]).toBe('1.2.3');
  });
});

describe('check (CLI-3)', () => {
  const answer = (status: number, outcome?: string) =>
    vi.fn(
      async () =>
        new Response(status === 200 ? 'x' : null, {
          status,
          headers: outcome ? { 'x-nx-cache-outcome': outcome } : {},
        }),
    );

  it('sends GET for the probe hash with the token', async () => {
    const { run, fetch } = setup();
    expect(await run('check')).toBe(EXIT.ok);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://nx-cache.example.com/web-platform/v1/cache/nxs3cacheprobe');
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Bearer nxcache-v1\./);
  });

  it.each([
    ['a miss', 404, 'miss', EXIT.ok, 'authenticated, read allowed'],
    ['a hit', 200, 'hit', EXIT.ok, 'authenticated, read allowed'],
    [
      'forbidden',
      404,
      'forbidden',
      EXIT.credentials,
      "your AWS role is not on the cache's allowed list",
    ],
    [
      'a 403 without an outcome',
      403,
      undefined,
      EXIT.credentials,
      "not on the cache's allowed list",
    ],
    ['unauthenticated', 404, 'unauthenticated', EXIT.credentials, 'token rejected'],
    ['a 401 without an outcome', 401, undefined, EXIT.credentials, 'token rejected'],
    ['a bad request', 404, 'bad_request', EXIT.config, 'Check the workspace ID'],
    [
      'a 404 that never reached the handler',
      404,
      undefined,
      EXIT.config,
      'no nx-s3-serverless-cache at this URL',
    ],
    ['an upstream error', 404, 'upstream_error', EXIT.server, 'server problem'],
    ['a disabled cache', 404, 'disabled', EXIT.server, 'turned off by its operator'],
    ['a 502 from the gateway', 502, undefined, EXIT.server, 'server problem (HTTP 502)'],
    ['a 429 from the gateway', 429, undefined, EXIT.server, 'server problem (HTTP 429)'],
  ])('reports %s', async (_name, status, outcome, code, message) => {
    const { run, out } = setup({
      fetch: answer(status, outcome) as unknown as typeof globalThis.fetch,
    });
    expect(await run('check')).toBe(code);
    expect(out.find((l) => l.startsWith('Result:'))).toContain(message);
  });

  it('says that write access was not checked', async () => {
    const { run, out } = setup();
    await run('check');
    expect(out).toContain(
      'Write access cannot be checked without writing. Every role that can read can also write.',
    );
  });

  it('exits 3 when the server is unreachable', async () => {
    const fetch = vi.fn(async () => Promise.reject(new TypeError('fetch failed')));
    const { run, out } = setup({ fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await run('check')).toBe(EXIT.server);
    expect(out.at(-1)).toContain('server unreachable');
  });
});

describe('stripJsonc', () => {
  it('keeps comment-like text inside strings', () => {
    expect(JSON.parse(stripJsonc('{"a": "http://x/*y*/", // c\n "b": "\\"//", }'))).toEqual({
      a: 'http://x/*y*/',
      b: '"//',
    });
  });
});
