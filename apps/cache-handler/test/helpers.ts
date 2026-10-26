// Test helpers: presigned tokens, API Gateway events, a fake STS server that
// checks SigV4 signatures, and an in-memory S3 with conditional writes.
import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GetObjectCommand, type PutObjectCommand } from '@aws-sdk/client-s3';
import { SignatureV4 } from '@smithy/signature-v4';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { AUDIENCE_HEADER, TOKEN_PREFIX } from '@nx-s3-serverless-cache/token-format';
import type { Config } from '../src/config.js';
import { ROUTE_RESOURCE } from '../src/handler.js';
import type { S3Sender } from '../src/storage.js';
import type { RequestRecord } from '../src/telemetry.js';

export const REGION = 'eu-west-1';
export const AUDIENCE = 'nx-cache.example.com';
export const STS_HOST = `sts.${REGION}.amazonaws.com`;
export const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

export interface TestCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export const CREDENTIALS: TestCredentials = {
  accessKeyId: 'ASIAEXAMPLEALLOWED01',
  secretAccessKey: 'secret-allowed',
  sessionToken: 'session-token-allowed+/=',
};

type SourceData = string | ArrayBuffer | ArrayBufferView;

const toBuffer = (data: SourceData): Buffer | string =>
  typeof data === 'string'
    ? data
    : ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data);

class Sha256 {
  private hash;
  constructor(private readonly secret?: SourceData) {
    this.hash = this.create();
  }
  private create() {
    return this.secret === undefined
      ? createHash('sha256')
      : createHmac('sha256', toBuffer(this.secret));
  }
  update(data: SourceData): void {
    this.hash.update(toBuffer(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
  reset(): void {
    this.hash = this.create();
  }
}

export interface PresignOptions {
  credentials?: TestCredentials;
  region?: string;
  audience?: string;
  signedAt?: number;
  expiresIn?: number;
}

/** Presigns GetCallerIdentity the way the client package does (02 §3). */
export async function presign(options: PresignOptions = {}): Promise<string> {
  const region = options.region ?? REGION;
  const signer = new SignatureV4({
    service: 'sts',
    region,
    credentials: options.credentials ?? CREDENTIALS,
    sha256: Sha256,
  });
  const hostname = `sts.${region}.amazonaws.com`;
  const signed = await signer.presign(
    {
      method: 'GET',
      protocol: 'https:',
      hostname,
      path: '/',
      query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
      headers: { host: hostname, [AUDIENCE_HEADER]: options.audience ?? AUDIENCE },
    },
    {
      expiresIn: options.expiresIn ?? 3600,
      signingDate: new Date(options.signedAt ?? NOW),
      unhoistableHeaders: new Set([AUDIENCE_HEADER]),
    },
  );
  const query = Object.entries(signed.query ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `https://${hostname}/?${query}`;
}

export function tokenFor(url: string): string {
  return TOKEN_PREFIX + Buffer.from(url, 'utf8').toString('base64url');
}

export async function bearer(options: PresignOptions = {}): Promise<string> {
  return `Bearer ${tokenFor(await presign(options))}`;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    bucketName: 'nx-cache-test-artifacts-111111111111',
    stsRegion: REGION,
    tokenAudience: AUDIENCE,
    tokenMaxLifetimeSeconds: 3600,
    maxArtifactBytes: 4 * 1024 * 1024,
    allowedRoles: new Set(['111111111111:ci-runner', '222222222222:awsreservedsso_dev_0123abcd']),
    environment: 'test',
    cacheEnabled: true,
    ...overrides,
  };
}

export interface EventOptions {
  method?: string;
  workspace?: string;
  hash?: string;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body?: Buffer | string | null;
  isBase64Encoded?: boolean;
  resource?: string;
}

/** An API Gateway REST proxy event as the deployed route produces it. */
export function makeEvent(options: EventOptions = {}): APIGatewayProxyEvent {
  const workspace = options.workspace ?? 'web-platform';
  const hash = options.hash ?? '8485680016397879100';
  const body = options.body ?? null;
  const headers = { 'User-Agent': 'nx-test', ...(options.headers ?? {}) };
  return {
    resource: options.resource ?? ROUTE_RESOURCE,
    path: `/${workspace}/v1/cache/${hash}`,
    httpMethod: options.method ?? 'GET',
    headers,
    multiValueHeaders:
      options.multiValueHeaders ??
      Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]])),
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: { workspace, hash },
    stageVariables: null,
    requestContext: {
      requestId: 'api-request-1',
      identity: { sourceIp: '198.51.100.7' },
    } as APIGatewayProxyEvent['requestContext'],
    body: Buffer.isBuffer(body) ? body.toString('base64') : body,
    isBase64Encoded: options.isBase64Encoded ?? Buffer.isBuffer(body),
  };
}

export const CONTEXT = { awsRequestId: 'lambda-request-1' };

export function collector(): { records: RequestRecord[]; emit: (r: RequestRecord) => void } {
  const records: RequestRecord[] = [];
  return { records, emit: (r) => records.push(r) };
}

// ---------------------------------------------------------------------------
// Fake STS (08, IT-1)

export interface FakeIdentity {
  credentials: TestCredentials;
  arn: string;
}

export type FakeStsMode = 'ok' | 'error500' | 'throttle' | 'hang' | 'malformed';

/**
 * Checks presigned GetCallerIdentity requests like STS does: recomputes the
 * signature with the caller's secret, including the audience header the
 * handler sends, and rejects expired requests.
 */
export class FakeSts {
  mode: FakeStsMode = 'ok';
  requests = 0;
  private server?: Server;
  private readonly identities = new Map<string, FakeIdentity>();

  constructor(
    identities: FakeIdentity[],
    private readonly now: () => number = () => NOW,
  ) {
    for (const identity of identities)
      this.identities.set(identity.credentials.accessKeyId, identity);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.requests++;
      void this.answer(req.url ?? '/', req.headers).then(({ status, body }) => {
        if (status === 0) return; // hang
        res.writeHead(status, {
          'content-type': 'application/json',
          'x-amzn-requestid': 'sts-request-1',
        });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private async answer(url: string, headers: Record<string, string | string[] | undefined>) {
    const error = (status: number, code: string) => ({
      status,
      body: JSON.stringify({
        Error: { Code: code, Message: code, Type: 'Sender' },
        RequestId: 'sts-request-1',
      }),
    });
    if (this.mode === 'hang') return { status: 0, body: '' };
    if (this.mode === 'error500') return error(500, 'InternalFailure');
    if (this.mode === 'throttle') return error(400, 'Throttling');

    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const [accessKeyId] = (query.get('X-Amz-Credential') ?? '').split('/');
    const identity = this.identities.get(accessKeyId ?? '');
    if (!identity) return error(403, 'InvalidClientTokenId');

    const date = query.get('X-Amz-Date') ?? '';
    const signedAt = Date.UTC(
      +date.slice(0, 4),
      +date.slice(4, 6) - 1,
      +date.slice(6, 8),
      +date.slice(9, 11),
      +date.slice(11, 13),
      +date.slice(13, 15),
    );
    const expiresIn = Number(query.get('X-Amz-Expires'));
    if (this.now() > signedAt + expiresIn * 1000) return error(403, 'ExpiredToken');

    const audience = headers[AUDIENCE_HEADER];
    const expected = new URLSearchParams(
      (
        await presign({
          credentials: identity.credentials,
          audience: typeof audience === 'string' ? audience : '',
          signedAt,
          expiresIn,
        })
      ).split('?')[1],
    ).get('X-Amz-Signature');
    if (expected !== query.get('X-Amz-Signature')) return error(403, 'SignatureDoesNotMatch');

    if (this.mode === 'malformed') return { status: 200, body: '{"unexpected":true}' };
    const account = identity.arn.split(':')[4];
    return {
      status: 200,
      body: JSON.stringify({
        GetCallerIdentityResponse: {
          GetCallerIdentityResult: {
            Account: account,
            Arn: identity.arn,
            UserId: `AROAEXAMPLE:${accessKeyId}`,
          },
          ResponseMetadata: { RequestId: 'sts-request-1' },
        },
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// In-memory S3 (08, UT-4 and IT-2)

export function s3Error(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode, requestId: 's3-request-1' },
  });
}

export interface StoredObject {
  body: Buffer;
  metadata: Record<string, string>;
  checksum?: string;
}

/** Mimics conditional PutObject: 412 if the key exists, 409 if a write is in flight. */
export class MemoryS3 implements S3Sender {
  readonly objects = new Map<string, StoredObject>();
  readonly commands: Array<GetObjectCommand | PutObjectCommand> = [];
  private readonly inFlight = new Set<string>();
  failWith?: Error;

  constructor(private readonly writeDelayMs = 0) {}

  async send(command: GetObjectCommand | PutObjectCommand): Promise<unknown> {
    this.commands.push(command);
    if (this.failWith) throw this.failWith;
    const key = command.input.Key!;
    if (command instanceof GetObjectCommand) {
      const found = this.objects.get(key);
      if (!found) throw s3Error('NoSuchKey', 404);
      return {
        ContentLength: found.body.length,
        Body: { transformToByteArray: async () => new Uint8Array(found.body) },
      };
    }
    if (command.input.IfNoneMatch === '*' && this.objects.has(key))
      throw s3Error('PreconditionFailed', 412);
    if (this.inFlight.has(key)) throw s3Error('ConditionalRequestConflict', 409);
    this.inFlight.add(key);
    try {
      await new Promise((r) => setTimeout(r, this.writeDelayMs));
      if (command.input.IfNoneMatch === '*' && this.objects.has(key))
        throw s3Error('PreconditionFailed', 412);
      const body = Buffer.from(command.input.Body as Buffer);
      const checksum = createHash('sha256').update(body).digest('base64');
      if (command.input.ChecksumSHA256 !== undefined && command.input.ChecksumSHA256 !== checksum) {
        throw s3Error('BadDigest', 400);
      }
      this.objects.set(key, { body, metadata: command.input.Metadata ?? {}, checksum });
      return {};
    } finally {
      this.inFlight.delete(key);
    }
  }
}
