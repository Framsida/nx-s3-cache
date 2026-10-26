// IT-1 and IT-2: the real handler, authenticator and storage, with a fake STS
// server (reached through the constructor-injected transport) and an
// in-memory S3 with conditional writes.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Authenticator } from '../src/auth.js';
import { createHandler, type Handler } from '../src/handler.js';
import { S3Storage } from '../src/storage.js';
import { StsVerifier, type StsTransport } from '../src/sts.js';
import type { RequestRecord } from '../src/telemetry.js';
import {
  AUDIENCE,
  bearer,
  collector,
  CONTEXT,
  CREDENTIALS,
  FakeSts,
  makeEvent,
  MemoryS3,
  NOW,
  REGION,
  STS_HOST,
  testConfig,
  type TestCredentials,
} from './helpers.js';

const UNLISTED: TestCredentials = {
  accessKeyId: 'ASIAEXAMPLEUNLISTED1',
  secretAccessKey: 'secret-unlisted',
  sessionToken: 't',
};
const USER: TestCredentials = {
  accessKeyId: 'AKIAEXAMPLEUSER00001',
  secretAccessKey: 'secret-user',
};

const sts = new FakeSts([
  { credentials: CREDENTIALS, arn: 'arn:aws:sts::111111111111:assumed-role/ci-runner/build-7' },
  { credentials: UNLISTED, arn: 'arn:aws:sts::333333333333:assumed-role/ci-runner/build-8' },
  { credentials: USER, arn: 'arn:aws:iam::111111111111:user/ci-runner' },
]);
let origin: string;

beforeAll(async () => {
  origin = await sts.start();
});
afterAll(() => sts.stop());

interface Stack {
  handler: Handler;
  s3: MemoryS3;
  records: RequestRecord[];
  transport: ReturnType<typeof vi.fn>;
}

function stack(options: { writeDelayMs?: number; stsTimeoutMs?: number } = {}): Stack {
  // Test-only transport: same request, sent to the fake STS instead of AWS.
  const transport = vi.fn<StsTransport>((url, init) =>
    fetch(url.replace(`https://${STS_HOST}`, origin), { ...init, redirect: 'manual' }),
  );
  const s3 = new MemoryS3(options.writeDelayMs);
  const { records, emit } = collector();
  const config = testConfig();
  const handler = createHandler({
    config,
    authenticator: new Authenticator({
      region: REGION,
      maxLifetimeSeconds: config.tokenMaxLifetimeSeconds,
      verifier: new StsVerifier(AUDIENCE, { transport, timeoutMs: options.stsTimeoutMs ?? 2000 }),
      now: () => NOW,
    }),
    storage: new S3Storage(s3, config.bucketName),
    emit,
  });
  return { handler, s3, records, transport };
}

const get = (authorization: string, hash = '123') =>
  makeEvent({ hash, headers: { Authorization: authorization } });
const put = (authorization: string, body: Buffer, hash = '123') =>
  makeEvent({
    method: 'PUT',
    hash,
    body,
    headers: { Authorization: authorization, 'Content-Length': String(body.length) },
  });

beforeEach(() => {
  sts.mode = 'ok';
});

describe('IT-1: handler with a fake STS', () => {
  it('stores an artifact and returns the same bytes', async () => {
    const { handler, s3, records } = stack();
    const auth = await bearer();
    const body = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));

    expect((await handler(get(auth), CONTEXT)).statusCode).toBe(404);
    expect((await handler(put(auth, body), CONTEXT)).statusCode).toBe(200);
    const hit = await handler(get(auth), CONTEXT);
    expect(hit.statusCode).toBe(200);
    expect(Buffer.from(hit.body, 'base64')).toEqual(body);

    expect(s3.objects.get('v1/web-platform/123')?.metadata).toEqual({
      writer: 'role:111111111111:ci-runner',
      'writer-session': 'build-7',
      'nx-workspace': 'web-platform',
    });
    expect(records.map((r) => r.outcome)).toEqual(['miss', 'stored', 'hit']);
    expect(records.map((r) => r.authCache)).toEqual(['miss', 'hit', 'hit']);
  });

  it('asks STS once per token while it is cached (02, VAL-3)', async () => {
    const { handler, transport } = stack();
    const auth = await bearer();
    for (let i = 0; i < 3; i++) await handler(get(auth), CONTEXT);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('treats a role on another account as forbidden', async () => {
    const { handler, records } = stack();
    const res = await handler(
      put(await bearer({ credentials: UNLISTED }), Buffer.from('x')),
      CONTEXT,
    );
    expect(res.statusCode).toBe(403);
    expect(records[0]).toMatchObject({
      outcome: 'forbidden',
      principal: 'role:333333333333:ci-runner',
    });
  });

  it('never allows an IAM user', async () => {
    const { handler, records } = stack();
    await handler(get(await bearer({ credentials: USER })), CONTEXT);
    expect(records[0]).toMatchObject({
      outcome: 'forbidden',
      principal: 'user:111111111111:ci-runner',
    });
  });

  it('rejects a token signed with the wrong secret', async () => {
    const { handler, records } = stack();
    await handler(
      get(await bearer({ credentials: { ...CREDENTIALS, secretAccessKey: 'wrong' } })),
      CONTEXT,
    );
    expect(records[0]).toMatchObject({
      outcome: 'unauthenticated',
      errorCode: 'SignatureDoesNotMatch',
    });
  });

  it('rejects a token made for another deployment (02, TOK-1)', async () => {
    const { handler, records } = stack();
    await handler(get(await bearer({ audience: 'other-cache.example.com' })), CONTEXT);
    expect(records[0]).toMatchObject({
      outcome: 'unauthenticated',
      errorCode: 'SignatureDoesNotMatch',
    });
  });

  it('rejects a token for another region without contacting STS', async () => {
    const { handler, records, transport } = stack();
    await handler(get(await bearer({ region: 'us-east-1' })), CONTEXT);
    expect(records[0]).toMatchObject({ outcome: 'unauthenticated' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['returns 500', 'error500', 'InternalFailure'],
    ['throttles', 'throttle', 'Throttling'],
    ['answers with something that is not an identity', 'malformed', 'MalformedResponse'],
  ] as const)('fails closed when STS %s', async (_name, mode, errorCode) => {
    sts.mode = mode;
    const { handler, records, s3 } = stack();
    const res = await handler(put(await bearer(), Buffer.from('x')), CONTEXT);
    expect(res.statusCode).toBe(403);
    expect(records[0]).toMatchObject({ outcome: 'upstream_error', upstream: 'sts', errorCode });
    expect(s3.commands).toHaveLength(0);
  });

  it('fails closed when STS does not answer in time', async () => {
    sts.mode = 'hang';
    const { handler, records } = stack({ stsTimeoutMs: 100 });
    const res = await handler(get(await bearer()), CONTEXT);
    expect(res.statusCode).toBe(404);
    expect(records[0]).toMatchObject({ outcome: 'upstream_error', errorCode: 'Timeout' });
  });

  it('never sends a token to a host other than the regional STS endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const config = testConfig();
    const handler = createHandler({
      config,
      // The production transport: no injection.
      authenticator: new Authenticator({
        region: REGION,
        maxLifetimeSeconds: 3600,
        verifier: new StsVerifier(AUDIENCE),
        now: () => NOW,
      }),
      storage: new S3Storage(new MemoryS3(), config.bucketName),
      emit: () => {},
    });
    const evil = `https://${STS_HOST}.evil.example/?Action=GetCallerIdentity`;
    const token = `nxcache-v1.${Buffer.from(evil).toString('base64url')}`;
    await handler(get(`Bearer ${token}`), CONTEXT);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('IT-2: concurrent uploads of the same hash', () => {
  it('store exactly one object and answer 200 once, 409 for the rest (01, CON-3)', async () => {
    const { handler, s3 } = stack({ writeDelayMs: 20 });
    const auth = await bearer();
    const bodies = Array.from({ length: 10 }, (_, i) => Buffer.from(`artifact ${i}`));
    const results = await Promise.all(bodies.map((b) => handler(put(auth, b, '777'), CONTEXT)));
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    expect(s3.objects.size).toBe(1);
    const winner = results.findIndex((r) => r.statusCode === 200);
    expect(s3.objects.get('v1/web-platform/777')?.body).toEqual(bodies[winner]);
  });

  it('keep the first object when a later upload arrives', async () => {
    const { handler, s3 } = stack();
    const auth = await bearer();
    await handler(put(auth, Buffer.from('first'), '888'), CONTEXT);
    expect((await handler(put(auth, Buffer.from('second'), '888'), CONTEXT)).statusCode).toBe(409);
    expect(s3.objects.get('v1/web-platform/888')?.body.toString()).toBe('first');
  });
});
