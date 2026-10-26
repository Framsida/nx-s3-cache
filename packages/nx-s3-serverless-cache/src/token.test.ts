// UT-6: known-answer test. With fixed credentials and a fixed clock, our token
// must decode to the same presigned URL as an independent SigV4 implementation
// written from the AWS documentation ("Authenticating requests: using query
// parameters").
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createToken, TokenTooLargeError } from './token.js';

const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLE+/=token',
};
const now = new Date(Date.UTC(2026, 9, 26, 9, 30, 15));

/** RFC 3986 encoding, as SigV4 requires. */
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

function independentPresign(
  region: string,
  audience: string,
  expires: number,
  creds: typeof credentials | Omit<typeof credentials, 'sessionToken'>,
) {
  const host = `sts.${region}.amazonaws.com`;
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/sts/aws4_request`;
  const params: Record<string, string> = {
    Action: 'GetCallerIdentity',
    Version: '2011-06-15',
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host;x-nx-cache-audience',
  };
  if ('sessionToken' in creds) params['X-Amz-Security-Token'] = creds.sessionToken;
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k]!)}`)
    .join('&');
  const canonicalRequest = [
    'GET',
    '/',
    canonicalQuery,
    `host:${host}\nx-nx-cache-audience:${audience}\n`,
    'host;x-nx-cache-audience',
    sha256(''),
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, date), region), 'sts'),
    'aws4_request',
  );
  params['X-Amz-Signature'] = createHmac('sha256', key).update(stringToSign).digest('hex');
  return { host, params };
}

function decode(token: string) {
  expect(token.startsWith('nxcache-v1.')).toBe(true);
  const url = new URL(Buffer.from(token.slice('nxcache-v1.'.length), 'base64url').toString('utf8'));
  return { url, params: Object.fromEntries(url.searchParams) };
}

describe('createToken', () => {
  it('matches an independently computed presigned URL (temporary credentials)', async () => {
    const { token } = await createToken({
      credentials,
      region: 'eu-west-1',
      audience: 'nx-cache.example.com',
      lifetimeSeconds: 3600,
      now,
    });
    const { url, params } = decode(token);
    const expected = independentPresign('eu-west-1', 'nx-cache.example.com', 3600, credentials);
    expect(url.origin).toBe(`https://${expected.host}`);
    expect(url.pathname).toBe('/');
    expect(params).toEqual(expected.params);
  });

  it('matches without a session token', async () => {
    const { sessionToken: _, ...longTerm } = credentials;
    const { token } = await createToken({
      credentials: longTerm,
      region: 'us-east-1',
      audience: 'cache.internal',
      lifetimeSeconds: 900,
      now,
    });
    expect(decode(token).params).toEqual(
      independentPresign('us-east-1', 'cache.internal', 900, longTerm).params,
    );
  });

  it('signs the audience header, so another audience gives another signature (02, TOK-1)', async () => {
    const a = await createToken({
      credentials,
      region: 'eu-west-1',
      audience: 'a.example.com',
      lifetimeSeconds: 3600,
      now,
    });
    const b = await createToken({
      credentials,
      region: 'eu-west-1',
      audience: 'b.example.com',
      lifetimeSeconds: 3600,
      now,
    });
    expect(decode(a.token).params['X-Amz-Signature']).not.toBe(
      decode(b.token).params['X-Amz-Signature'],
    );
  });

  it('expires at now + lifetime when the credentials last longer', async () => {
    const result = await createToken({
      credentials: { ...credentials, expiration: new Date(now.getTime() + 8 * 3600_000) },
      region: 'eu-west-1',
      audience: 'a',
      lifetimeSeconds: 3600,
      now,
    });
    expect(result.expiresAt).toEqual(new Date(now.getTime() + 3600_000));
  });

  it('expires with the credentials when they expire first (05, PL-4)', async () => {
    const expiration = new Date(now.getTime() + 20 * 60_000);
    const result = await createToken({
      credentials: { ...credentials, expiration },
      region: 'eu-west-1',
      audience: 'a',
      lifetimeSeconds: 3600,
      now,
    });
    expect(result.expiresAt).toEqual(expiration);
  });

  it('refuses to make a token over 8 KB (02, TOK-4)', async () => {
    await expect(
      createToken({
        credentials: { ...credentials, sessionToken: 'x'.repeat(7000) },
        region: 'eu-west-1',
        audience: 'a',
        lifetimeSeconds: 3600,
        now,
      }),
    ).rejects.toThrow(TokenTooLargeError);
  });
});
