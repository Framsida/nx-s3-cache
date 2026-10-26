// UT-1: every step of 02 §4 steps 1-5, with the SSRF cases from 08.
import { beforeAll, describe, expect, it } from 'vitest';
import { CREDENTIALS, NOW, presign, REGION, STS_HOST, tokenFor } from '../test/helpers.js';
import { checkToken, MAX_CLOCK_SKEW_MS, sha256Hex } from './token.js';

const policy = { region: REGION, maxLifetimeSeconds: 3600 };
let url: string;

beforeAll(async () => {
  url = await presign();
});

const check = (authorization: string | undefined, now = NOW) =>
  checkToken(authorization, policy, now);
const withUrl = (u: string, now = NOW) => check(`Bearer ${tokenFor(u)}`, now);
const reason = (result: ReturnType<typeof checkToken>) => (result.ok ? 'accepted' : result.reason);

describe('accepting', () => {
  it('accepts a token made with temporary credentials', () => {
    const result = withUrl(url);
    expect(result).toMatchObject({ ok: true, token: { url, expiresAt: NOW + 3600_000 } });
    expect(url).toContain('X-Amz-Security-Token=');
  });

  it('accepts a token made without a session token', async () => {
    const plain = await presign({ credentials: { ...CREDENTIALS, sessionToken: undefined } });
    expect(plain).not.toContain('X-Amz-Security-Token');
    expect(withUrl(plain).ok).toBe(true);
  });

  it('accepts a lowercase scheme and several spaces', () => {
    expect(check(`bearer   ${tokenFor(url)}`).ok).toBe(true);
  });

  it('returns the SHA-256 of the whole token', () => {
    const token = tokenFor(url);
    const result = check(`Bearer ${token}`);
    expect(result.ok && result.token.tokenHash).toBe(sha256Hex(token));
  });

  it('accepts a token up to its last second and slightly in the future', () => {
    expect(withUrl(url, NOW + 3600_000).ok).toBe(true);
    expect(withUrl(url, NOW - MAX_CLOCK_SKEW_MS).ok).toBe(true);
  });
});

describe('step 1: header and encoding', () => {
  it.each([
    ['missing header', undefined, 'missing Authorization header'],
    ['empty header', '', 'missing Authorization header'],
    ['basic scheme', 'Basic dXNlcjpwYXNz', 'not a bearer token'],
    ['no token', 'Bearer', 'not a bearer token'],
    ['two tokens', 'Bearer a b', 'not a bearer token'],
    ['wrong prefix', 'Bearer nxcache-v2.aGVsbG8', 'unknown token format'],
    ['eks token', 'Bearer k8s-aws-v1.aHR0cHM6Ly9zdHM', 'unknown token format'],
    ['standard base64 characters', 'Bearer nxcache-v1.ab+/cd', 'token is not base64url'],
    ['padding', 'Bearer nxcache-v1.aGk=', 'token is not base64url'],
    ['impossible length', 'Bearer nxcache-v1.aGVsb', 'token is not base64url'],
    ['non-canonical trailing bits', 'Bearer nxcache-v1.aGF', 'token is not canonical base64url'],
    ['empty payload', 'Bearer nxcache-v1.', 'token is not base64url'],
  ])('rejects %s', (_name, header, expected) => {
    expect(reason(check(header))).toBe(expected);
  });

  it('rejects tokens over 8 KB', () => {
    expect(reason(check(`Bearer nxcache-v1.${'A'.repeat(8192)}`))).toBe('token too large');
  });

  it('rejects bytes that are not UTF-8', () => {
    const token = 'nxcache-v1.' + Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url');
    expect(reason(check(`Bearer ${token}`))).toBe('token is not UTF-8');
  });

  it('keeps the token hash for logs when the token is rejected', () => {
    const result = check('Bearer nxcache-v2.aGVsbG8');
    expect(result.ok === false && result.tokenHash).toBe(sha256Hex('nxcache-v2.aGVsbG8'));
  });
});

describe('step 2: STS host only (SSRF guard)', () => {
  const query = () => url.slice(url.indexOf('?'));
  it.each([
    ['look-alike host', () => `https://${STS_HOST}.evil.example/${query()}`],
    ['look-alike prefix', () => `https://evil.example/${STS_HOST}/${query()}`],
    ['user info', () => `https://user:pass@${STS_HOST}/${query()}`],
    ['host as user info', () => `https://${STS_HOST}@evil.example/${query()}`],
    ['explicit port', () => `https://${STS_HOST}:443/${query()}`],
    ['other port', () => `https://${STS_HOST}:8443/${query()}`],
    ['IPv4 literal', () => `https://52.94.0.1/${query()}`],
    ['IPv6 literal', () => `https://[::1]/${query()}`],
    ['trailing dot', () => `https://${STS_HOST}./${query()}`],
    ['uppercase host', () => `https://STS.EU-WEST-1.AMAZONAWS.COM/${query()}`],
    ['percent-encoded host', () => `https://sts%2Eeu-west-1.amazonaws.com/${query()}`],
    ['other region', () => `https://sts.us-east-1.amazonaws.com/${query()}`],
    ['global endpoint', () => `https://sts.amazonaws.com/${query()}`],
    ['http scheme', () => `http://${STS_HOST}/${query()}`],
    ['non-root path', () => `https://${STS_HOST}/evil${query()}`],
    ['path traversal', () => `https://${STS_HOST}/../${query()}`],
    ['no query', () => `https://${STS_HOST}/`],
    ['backslash authority', () => `https://${STS_HOST}\\@evil.example/${query()}`],
  ])('rejects %s', (_name, make) => {
    expect(withUrl(make()).ok).toBe(false);
  });

  it.each([
    ['a fragment', (u: string) => `${u}#frag`],
    ['a space', (u: string) => u.replace('Action=', 'Action= ')],
    ['a newline', (u: string) => `${u}\n`],
    ['non-ASCII', (u: string) => `${u}é`],
  ])('rejects a URL containing %s', (_name, mutate) => {
    expect(reason(withUrl(mutate(url)))).toBe('token URL has unexpected characters');
  });
});

describe('step 3: query parameters', () => {
  it.each([
    ['an extra parameter', (u: string) => `${u}&Foo=bar`],
    ['a repeated parameter', (u: string) => `${u}&Action=GetCallerIdentity`],
    ['a repeated parameter, differently encoded', (u: string) => `${u}&Act%69on=GetCallerIdentity`],
    ['an empty segment', (u: string) => u.replace('&', '&&')],
    ['a parameter without a value separator', (u: string) => `${u}&Action`],
    ['bad percent-encoding', (u: string) => `${u}&X-Amz-%zz=1`],
    [
      'a different action',
      (u: string) => u.replace('Action=GetCallerIdentity', 'Action=AssumeRole'),
    ],
    [
      'a different API version',
      (u: string) => u.replace('Version=2011-06-15', 'Version=2099-01-01'),
    ],
    ['a different algorithm', (u: string) => u.replace('AWS4-HMAC-SHA256', 'AWS4-HMAC-SHA1')],
    ['no signature', (u: string) => u.replace(/&?X-Amz-Signature=[^&]*/, '')],
    ['no credential', (u: string) => u.replace(/&?X-Amz-Credential=[^&]*/, '')],
  ])('rejects %s', (_name, mutate) => {
    expect(withUrl(mutate(url)).ok).toBe(false);
  });
});

describe('step 4: audience binding', () => {
  it('rejects a token whose audience header is not signed', () => {
    const unsigned = url.replace(/X-Amz-SignedHeaders=[^&]*/, 'X-Amz-SignedHeaders=host');
    expect(reason(withUrl(unsigned))).toBe('audience header is not signed');
  });

  it('rejects a token without the host header signed', () => {
    const unsigned = url.replace(
      /X-Amz-SignedHeaders=[^&]*/,
      'X-Amz-SignedHeaders=x-nx-cache-audience',
    );
    expect(reason(withUrl(unsigned))).toBe('audience header is not signed');
  });
});

describe('step 5: lifetime', () => {
  it('rejects an expired token', () => {
    expect(reason(withUrl(url, NOW + 3600_000 + 1))).toBe('token expired');
  });

  it('rejects a token dated more than 5 minutes ahead', () => {
    expect(reason(withUrl(url, NOW - MAX_CLOCK_SKEW_MS - 1000))).toBe(
      'token is dated in the future',
    );
  });

  it('rejects a lifetime above the configured maximum', async () => {
    const long = await presign({ expiresIn: 7200 });
    expect(reason(withUrl(long))).toBe('token lifetime out of range');
  });

  it.each([
    ['X-Amz-Expires=0', 'token lifetime out of range'],
    ['X-Amz-Expires=-1', 'malformed X-Amz-Expires'],
    ['X-Amz-Expires=1e3', 'malformed X-Amz-Expires'],
    ['X-Amz-Expires=9999999', 'malformed X-Amz-Expires'],
  ])('rejects %s', (replacement, expected) => {
    expect(reason(withUrl(url.replace(/X-Amz-Expires=\d+/, replacement)))).toBe(expected);
  });

  it('rejects a malformed X-Amz-Date', () => {
    expect(reason(withUrl(url.replace(/X-Amz-Date=\w+/, 'X-Amz-Date=2026-10-26')))).toBe(
      'malformed X-Amz-Date',
    );
  });
});
