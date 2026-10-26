// Token creation (02 §3): a presigned STS GetCallerIdentity request whose
// signature covers the audience header. Signing makes no network call.
import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentity } from '@smithy/types';
import {
  AUDIENCE_HEADER,
  MAX_TOKEN_BYTES,
  STS_ACTION,
  STS_HOSTNAME_PREFIX,
  STS_HOSTNAME_SUFFIX,
  STS_SERVICE,
  STS_VERSION,
  TOKEN_PREFIX,
} from '@nx-s3-serverless-cache/token-format';

type SourceData = string | ArrayBuffer | ArrayBufferView;

function toBinary(data: SourceData): Buffer | string {
  if (typeof data === 'string') return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

/** SHA-256 and HMAC-SHA-256 from node:crypto, in the shape SignatureV4 expects. */
class Sha256 {
  private hash;

  constructor(private readonly secret?: SourceData) {
    this.hash = this.create();
  }

  private create() {
    return this.secret === undefined
      ? createHash('sha256')
      : createHmac('sha256', toBinary(this.secret));
  }

  update(data: SourceData): void {
    this.hash.update(toBinary(data));
  }

  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }

  reset(): void {
    this.hash = this.create();
  }
}

export interface TokenRequest {
  credentials: AwsCredentialIdentity;
  region: string;
  audience: string;
  lifetimeSeconds: number;
  now: Date;
}

export interface Token {
  token: string;
  /** The earlier of now + lifetime and the credentials' own expiry (05, PL-4). */
  expiresAt: Date;
}

export class TokenTooLargeError extends Error {
  override name = 'TokenTooLargeError';
}

export async function createToken(request: TokenRequest): Promise<Token> {
  // Regional endpoint of the deployment region, never the global one (02, TOK-2).
  const hostname = `${STS_HOSTNAME_PREFIX}${request.region}${STS_HOSTNAME_SUFFIX}`;
  const signer = new SignatureV4({
    service: STS_SERVICE,
    region: request.region,
    credentials: request.credentials,
    sha256: Sha256,
  });
  const signed = await signer.presign(
    {
      method: 'GET',
      protocol: 'https:',
      hostname,
      path: '/',
      query: { Action: STS_ACTION, Version: STS_VERSION },
      headers: { host: hostname, [AUDIENCE_HEADER]: request.audience },
    },
    { expiresIn: request.lifetimeSeconds, signingDate: request.now },
  );

  const query = Object.entries(signed.query ?? {})
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  const url = `https://${hostname}/?${query}`;
  const token = TOKEN_PREFIX + Buffer.from(url, 'utf8').toString('base64url');
  if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    throw new TokenTooLargeError(
      `token is ${Buffer.byteLength(token)} bytes; the limit is ${MAX_TOKEN_BYTES}`,
    );
  }

  const lifetimeEnd = request.now.getTime() + request.lifetimeSeconds * 1000;
  const credentialsEnd = request.credentials.expiration?.getTime() ?? Infinity;
  return { token, expiresAt: new Date(Math.min(lifetimeEnd, credentialsEnd)) };
}
