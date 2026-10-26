// Token checks that need no network call: steps 1 to 5 of 02 §4. Step 2 is the
// guard against server-side request forgery (02, VAL-1): only a URL on the
// deployment region's STS host ever leaves this module.
import { createHash } from 'node:crypto';
import {
  AUDIENCE_HEADER,
  MAX_TOKEN_BYTES,
  OPTIONAL_QUERY_PARAMETERS,
  REQUIRED_QUERY_PARAMETERS,
  SIGNING_ALGORITHM,
  STS_ACTION,
  STS_HOSTNAME_PREFIX,
  STS_HOSTNAME_SUFFIX,
  STS_VERSION,
  TOKEN_PREFIX,
} from '@nx-s3-serverless-cache/token-format';

/** How far `X-Amz-Date` may be ahead of the server clock (02, step 5). */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface TokenPolicy {
  region: string;
  maxLifetimeSeconds: number;
}

export interface ValidToken {
  /** The presigned URL, exactly as decoded. It is on the regional STS host. */
  url: string;
  /** SHA-256 of the whole token, hex. Never log more than 8 characters (02, VAL-2). */
  tokenHash: string;
  /** When the presigned request stops being valid, in epoch milliseconds. */
  expiresAt: number;
}

export type TokenCheck =
  { ok: true; token: ValidToken } | { ok: false; reason: string; tokenHash?: string };

const BEARER = /^Bearer +([^\s]+)$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const AMZ_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const ALLOWED_PARAMETERS = new Set<string>([
  ...REQUIRED_QUERY_PARAMETERS,
  ...OPTIONAL_QUERY_PARAMETERS,
]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function stsHostname(region: string): string {
  return `${STS_HOSTNAME_PREFIX}${region}${STS_HOSTNAME_SUFFIX}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function checkToken(
  authorization: string | undefined,
  policy: TokenPolicy,
  now: number,
): TokenCheck {
  // Step 1: header, scheme, prefix, size, encoding.
  if (authorization === undefined || authorization === '')
    return { ok: false, reason: 'missing Authorization header' };
  const bearer = BEARER.exec(authorization);
  if (!bearer) return { ok: false, reason: 'not a bearer token' };
  const token = bearer[1]!;
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES)
    return { ok: false, reason: 'token too large' };
  const tokenHash = sha256Hex(token);
  const reject = (reason: string): TokenCheck => ({ ok: false, reason, tokenHash });

  if (!token.startsWith(TOKEN_PREFIX)) return reject('unknown token format');
  const encoded = token.slice(TOKEN_PREFIX.length);
  if (!BASE64URL.test(encoded) || encoded.length % 4 === 1) return reject('token is not base64url');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) return reject('token is not canonical base64url');
  let url: string;
  try {
    url = UTF8.decode(bytes);
  } catch {
    return reject('token is not UTF-8');
  }

  // Step 2: the URL is exactly the regional STS endpoint. The raw prefix check
  // rules out user info, ports, IP literals, trailing dots, case and percent
  // tricks before any URL parser sees the string; the parsed checks repeat it.
  const host = stsHostname(policy.region);
  const prefix = `https://${host}/?`;
  if (!url.startsWith(prefix)) return reject('token URL is not the STS endpoint of this region');
  if (/[^\x21-\x7e]/.test(url) || url.includes('#'))
    return reject('token URL has unexpected characters');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return reject('token URL does not parse');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.hostname !== host ||
    parsed.pathname !== '/'
  ) {
    return reject('token URL is not the STS endpoint of this region');
  }

  // Step 3: only the expected query parameters, each once.
  const params = new Map<string, string>();
  for (const part of url.slice(prefix.length).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return reject('malformed query parameter');
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(part.slice(0, eq));
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return reject('malformed query parameter');
    }
    if (!ALLOWED_PARAMETERS.has(key))
      return reject(`unexpected query parameter ${key.slice(0, 40)}`);
    if (params.has(key)) return reject(`repeated query parameter ${key}`);
    params.set(key, value);
  }
  for (const key of REQUIRED_QUERY_PARAMETERS) {
    if (!params.has(key)) return reject(`missing query parameter ${key}`);
  }
  if (params.get('Action') !== STS_ACTION) return reject('Action is not GetCallerIdentity');
  if (params.get('Version') !== STS_VERSION) return reject('unexpected STS API version');
  if (params.get('X-Amz-Algorithm') !== SIGNING_ALGORITHM)
    return reject('unexpected signing algorithm');

  // Step 4: the audience header is signed, so STS checks it (02, TOK-1).
  const signedHeaders = params.get('X-Amz-SignedHeaders')!.split(';');
  if (!signedHeaders.includes('host') || !signedHeaders.includes(AUDIENCE_HEADER)) {
    return reject('audience header is not signed');
  }

  // Step 5: lifetime.
  const date = AMZ_DATE.exec(params.get('X-Amz-Date')!);
  if (!date) return reject('malformed X-Amz-Date');
  const [, y, mo, d, h, mi, s] = date.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const signedAt = Date.UTC(y, mo - 1, d, h, mi, s);
  const expiresRaw = params.get('X-Amz-Expires')!;
  if (!/^\d{1,6}$/.test(expiresRaw)) return reject('malformed X-Amz-Expires');
  const expiresSeconds = Number(expiresRaw);
  if (expiresSeconds < 1 || expiresSeconds > policy.maxLifetimeSeconds)
    return reject('token lifetime out of range');
  if (signedAt - now > MAX_CLOCK_SKEW_MS) return reject('token is dated in the future');
  const expiresAt = signedAt + expiresSeconds * 1000;
  if (now > expiresAt) return reject('token expired');

  return { ok: true, token: { url, tokenHash, expiresAt } };
}
