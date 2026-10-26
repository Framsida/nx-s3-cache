// UT-3: every row of 03 table 5.1 and every outcome in table 5.4, with the
// status mapping of D-34 (GET failures are misses, PUT failures are skipped
// uploads, so Nx never fails the command).
import { describe, expect, it, vi } from 'vitest';
import { collector, CONTEXT, makeEvent, testConfig, type EventOptions } from '../test/helpers.js';
import type { AuthResult, Authenticator } from './auth.js';
import type { Config } from './config.js';
import { createHandler, MESSAGES, oversizeMessage } from './handler.js';
import { normalizeIdentity } from './roles.js';
import type { GetResult, PutResult, S3Storage } from './storage.js';

const TOKEN = 'Bearer nxcache-v1.c2VjcmV0LXRva2VuLXZhbHVl';
const allowed: AuthResult = {
  ok: true,
  identity: normalizeIdentity('arn:aws:sts::111111111111:assumed-role/ci-runner/build-7'),
  tokenHash8: 'abcdef01',
  authCache: 'miss',
  stsMs: 40,
};

function setup(
  options: {
    auth?: AuthResult;
    get?: GetResult | Error;
    put?: PutResult | Error;
    config?: Partial<Config>;
  } = {},
) {
  const authenticate = vi.fn<Authenticator['authenticate']>(async () => options.auth ?? allowed);
  const get = vi.fn<S3Storage['get']>(async () => {
    if (options.get instanceof Error) throw options.get;
    return options.get ?? { kind: 'miss' as const, s3Ms: 3 };
  });
  const put = vi.fn<S3Storage['put']>(async () => {
    if (options.put instanceof Error) throw options.put;
    return options.put ?? { kind: 'stored' as const, s3Ms: 5 };
  });
  const { records, emit } = collector();
  const handler = createHandler({
    config: testConfig(options.config),
    authenticator: { authenticate },
    storage: { get, put },
    emit,
  });
  const call = (event: EventOptions) =>
    handler(makeEvent({ headers: { Authorization: TOKEN }, ...event }), CONTEXT);
  return { call, authenticate, get, put, records };
}

const putEvent = (body: Buffer, extra: EventOptions = {}): EventOptions => ({
  method: 'PUT',
  body,
  ...extra,
  headers: {
    Authorization: TOKEN,
    'Content-Length': String(body.length),
    ...(extra.headers ?? {}),
  },
});

describe('step 1: method and route', () => {
  it.each(['POST', 'DELETE', 'HEAD', 'PATCH'])(
    'answers %s with 404 and no body',
    async (method) => {
      const { call, authenticate, records } = setup();
      const res = await call({ method });
      expect(res).toMatchObject({ statusCode: 404, body: '' });
      expect(authenticate).not.toHaveBeenCalled();
      expect(records[0]).toMatchObject({ outcome: 'bad_request', status: 404 });
    },
  );

  it('answers an unknown resource with 404', async () => {
    const { call } = setup();
    expect((await call({ resource: '/{proxy+}' })).statusCode).toBe(404);
  });
});

describe('step 2: workspace and hash syntax', () => {
  const traversal: Array<[string, Partial<EventOptions>]> = [
    ['workspace ..', { workspace: '..' }],
    ['workspace .', { workspace: '.' }],
    ['workspace with %2F', { workspace: 'a%2Fb' }],
    ['workspace with a slash', { workspace: 'a/b' }],
    ['empty workspace', { workspace: '' }],
    ['uppercase workspace', { workspace: 'Web' }],
    ['workspace with a Unicode slash', { workspace: 'a∕b' }],
    ['workspace with encoded dots', { workspace: '%2e%2e' }],
    ['workspace with a NUL', { workspace: 'a\u0000b' }],
    ['hash ..', { hash: '..' }],
    ['hash with a slash', { hash: '1/2' }],
    ['hash with encoded traversal', { hash: '%2e%2e%2f1' }],
    ['empty hash', { hash: '' }],
    ['hash with a semicolon', { hash: '1;2' }],
    ['hash with full-width digits', { hash: '１２' }],
    ['hash over 128 characters', { hash: '1'.repeat(129) }],
  ];

  it.each(traversal)('GET with %s is a miss, before authentication', async (_name, event) => {
    const { call, authenticate, records } = setup();
    const res = await call({ ...event });
    expect(res).toMatchObject({
      statusCode: 404,
      body: '',
      headers: { 'x-nx-cache-outcome': 'bad_request' },
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ outcome: 'bad_request' });
    // Unvalidated input never reaches logs or metric dimensions.
    expect(records[0]).not.toHaveProperty('workspace');
    expect(records[0]).not.toHaveProperty('hash');
  });

  it.each(traversal)('PUT with %s is a skipped upload', async (_name, event) => {
    const { call, authenticate, put } = setup();
    const res = await call({ ...putEvent(Buffer.from('x')), ...event });
    expect(res).toMatchObject({
      statusCode: 403,
      body: MESSAGES.bad_request,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-nx-cache-outcome': 'bad_request' },
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

describe('step 3: Content-Length on PUT', () => {
  it('requires Content-Length', async () => {
    const { call, authenticate } = setup();
    const res = await call({ method: 'PUT', body: Buffer.from('x') });
    expect(res).toMatchObject({ statusCode: 403, body: MESSAGES.length_required });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it.each(['abc', '-1', '1.5', '12 34', '', '99999999999'])(
    'rejects Content-Length %j',
    async (value) => {
      const { call, authenticate } = setup();
      const res = await call(putEvent(Buffer.from('x'), { headers: { 'Content-Length': value } }));
      expect(res.statusCode).toBe(403);
      expect(res.headers?.['x-nx-cache-outcome']).toBe('bad_request');
      expect(authenticate).not.toHaveBeenCalled();
    },
  );

  it('rejects repeated Content-Length headers that disagree', async () => {
    const { call } = setup();
    const res = await call({
      ...putEvent(Buffer.from('x')),
      multiValueHeaders: { Authorization: [TOKEN], 'Content-Length': ['1', '2'] },
    });
    expect(res.body).toBe(MESSAGES.length_required);
  });

  it('rejects an upload over the limit before authentication, with the sizes (03, SIZE-2)', async () => {
    const { call, authenticate, records } = setup({
      config: { maxArtifactBytes: 4 * 1024 * 1024 },
    });
    const res = await call(putEvent(Buffer.alloc(1), { headers: { 'Content-Length': '7549747' } }));
    expect(res).toMatchObject({ statusCode: 403, body: oversizeMessage(7549747, 4194304) });
    expect(res.body).toBe(
      'Nx cache: task output is 7.2 MB; the limit is 4.0 MB. It was not cached remotely.',
    );
    expect(authenticate).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ outcome: 'oversize', bytes: 7549747 });
  });

  it('accepts an upload of exactly the limit', async () => {
    const { call } = setup({ config: { maxArtifactBytes: 16 } });
    expect((await call(putEvent(Buffer.alloc(16)))).statusCode).toBe(200);
  });

  it('reads headers case-insensitively', async () => {
    const { call } = setup();
    const body = Buffer.from('abc');
    const res = await call({
      method: 'PUT',
      body,
      headers: { authorization: TOKEN, 'content-length': '3' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('step 4: authentication', () => {
  const unauthenticated: AuthResult = {
    ok: false,
    outcome: 'unauthenticated',
    reason: 'token expired',
    tokenHash8: '0badf00d',
  };
  const stsDown: AuthResult = {
    ok: false,
    outcome: 'upstream_error',
    reason: 'STS unavailable',
    errorCode: 'Timeout',
    stsMs: 3000,
  };

  it('passes the Authorization header to the authenticator', async () => {
    const { call, authenticate } = setup();
    await call({ headers: { authorization: TOKEN } });
    expect(authenticate).toHaveBeenCalledWith(TOKEN);
  });

  it('answers a rejected token on GET as a miss without touching storage', async () => {
    const { call, get, records } = setup({ auth: unauthenticated });
    const res = await call({});
    expect(res).toMatchObject({
      statusCode: 404,
      body: '',
      headers: { 'x-nx-cache-outcome': 'unauthenticated' },
    });
    expect(get).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      outcome: 'unauthenticated',
      tokenHash8: '0badf00d',
      reason: 'token expired',
    });
  });

  it('answers a rejected token on PUT as a skipped upload with advice', async () => {
    const { call, put } = setup({ auth: unauthenticated });
    const res = await call(putEvent(Buffer.from('x')));
    expect(res).toMatchObject({ statusCode: 403, body: MESSAGES.unauthenticated });
    expect(put).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT'])(
    'fails closed on %s when STS is unavailable (02, VAL-4)',
    async (method) => {
      const { call, get, put, records } = setup({ auth: stsDown });
      const res = await call(method === 'PUT' ? putEvent(Buffer.from('x')) : {});
      expect(res.statusCode).toBe(method === 'GET' ? 404 : 403);
      expect(res.headers?.['x-nx-cache-outcome']).toBe('upstream_error');
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(records[0]).toMatchObject({
        outcome: 'upstream_error',
        upstream: 'sts',
        errorCode: 'Timeout',
        stsMs: 3000,
      });
    },
  );
});

describe('step 5: authorization', () => {
  const unlisted: AuthResult = {
    ...allowed,
    identity: normalizeIdentity('arn:aws:sts::333333333333:assumed-role/other/s'),
  };
  const user: AuthResult = {
    ...allowed,
    identity: normalizeIdentity('arn:aws:iam::111111111111:user/ci-runner'),
  };

  it.each([
    ['an unlisted role', unlisted],
    ['an IAM user', user],
  ])('answers GET from %s as a miss without touching storage', async (_name, auth) => {
    const { call, get, records } = setup({ auth });
    const res = await call({});
    expect(res).toMatchObject({ statusCode: 404, headers: { 'x-nx-cache-outcome': 'forbidden' } });
    expect(get).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      outcome: 'forbidden',
      principal: auth.ok ? auth.identity.principal : '',
    });
  });

  it('answers PUT from an unlisted role as a skipped upload', async () => {
    const { call, put } = setup({ auth: unlisted });
    const res = await call(putEvent(Buffer.from('x')));
    expect(res).toMatchObject({ statusCode: 403, body: MESSAGES.forbidden });
    expect(put).not.toHaveBeenCalled();
  });
});

describe('step 6: GET', () => {
  it('returns a hit as base64 octet-stream (01, CON-9)', async () => {
    const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff]);
    const { call, get, records } = setup({ get: { kind: 'hit', body, s3Ms: 7 } });
    const res = await call({ workspace: 'web', hash: '42' });
    expect(res).toEqual({
      statusCode: 200,
      headers: { 'x-nx-cache-outcome': 'hit', 'content-type': 'application/octet-stream' },
      body: body.toString('base64'),
      isBase64Encoded: true,
    });
    expect(get).toHaveBeenCalledWith('web', '42');
    expect(records[0]).toMatchObject({
      outcome: 'hit',
      bytes: 5,
      s3Ms: 7,
      authorized: true,
      principal: 'role:111111111111:ci-runner',
      session: 'build-7',
    });
  });

  it('returns a miss as 404 with no body (01, CON-5)', async () => {
    const { call } = setup({ get: { kind: 'miss', s3Ms: 2 } });
    expect(await call({})).toEqual({
      statusCode: 404,
      headers: { 'x-nx-cache-outcome': 'miss' },
      body: '',
    });
  });

  it('answers an S3 failure as a miss and records it', async () => {
    const { call, records } = setup({
      get: { kind: 'error', errorCode: 'SlowDown', awsRequestId: 's3-1', s3Ms: 9 },
    });
    expect(await call({})).toMatchObject({
      statusCode: 404,
      headers: { 'x-nx-cache-outcome': 'upstream_error' },
    });
    expect(records[0]).toMatchObject({
      outcome: 'upstream_error',
      upstream: 's3',
      errorCode: 'SlowDown',
      awsRequestId: 's3-1',
    });
  });
});

describe('step 6: PUT', () => {
  it('stores the decoded bytes with the writer', async () => {
    const body = Buffer.from([0, 1, 2, 250, 251]);
    const { call, put, records } = setup();
    const res = await call(putEvent(body, { workspace: 'web', hash: '42' }));
    expect(res).toEqual({ statusCode: 200, headers: { 'x-nx-cache-outcome': 'stored' }, body: '' });
    expect(put).toHaveBeenCalledWith('web', '42', body, {
      principal: 'role:111111111111:ci-runner',
      session: 'build-7',
    });
    expect(records[0]).toMatchObject({
      outcome: 'stored',
      bytes: 5,
      principal: 'role:111111111111:ci-runner',
      session: 'build-7',
    });
  });

  it('stores a zero-byte upload', async () => {
    const { call, put } = setup();
    const res = await call({
      method: 'PUT',
      body: null,
      headers: { Authorization: TOKEN, 'Content-Length': '0' },
    });
    expect(res.statusCode).toBe(200);
    expect(put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      Buffer.alloc(0),
      expect.any(Object),
    );
  });

  it('accepts a body that API Gateway passed as text', async () => {
    const { call, put } = setup();
    await call({
      method: 'PUT',
      body: 'plain',
      isBase64Encoded: false,
      headers: { Authorization: TOKEN, 'Content-Length': '5' },
    });
    expect(put.mock.calls[0]?.[2]).toEqual(Buffer.from('plain'));
  });

  it('stores nothing when the body length differs from Content-Length (01, CON-4)', async () => {
    const { call, put, records } = setup();
    const res = await call(putEvent(Buffer.from('abc'), { headers: { 'Content-Length': '4' } }));
    expect(res).toMatchObject({ statusCode: 403, body: MESSAGES.bad_request });
    expect(put).not.toHaveBeenCalled();
    expect(records[0]?.reason).toBe('body is 3 bytes, Content-Length is 4');
  });

  it('answers an existing record with 409 and no body (01, CON-3)', async () => {
    const { call } = setup({ put: { kind: 'exists', s3Ms: 4 } });
    expect(await call(putEvent(Buffer.from('x')))).toEqual({
      statusCode: 409,
      headers: { 'x-nx-cache-outcome': 'exists' },
      body: '',
    });
  });

  it('answers an S3 failure as a skipped upload', async () => {
    const { call, records } = setup({ put: { kind: 'error', errorCode: 'AccessDenied', s3Ms: 4 } });
    expect(await call(putEvent(Buffer.from('x')))).toMatchObject({
      statusCode: 403,
      body: MESSAGES.upstream_error,
    });
    expect(records[0]).toMatchObject({
      outcome: 'upstream_error',
      upstream: 's3',
      errorCode: 'AccessDenied',
    });
  });
});

describe('kill switch (D-35)', () => {
  it.each(['GET', 'PUT'])(
    'answers %s without authenticating when the cache is disabled',
    async (method) => {
      const { call, authenticate } = setup({ config: { cacheEnabled: false } });
      const res = await call(method === 'PUT' ? putEvent(Buffer.from('x')) : {});
      expect(res.statusCode).toBe(method === 'GET' ? 404 : 403);
      expect(res.headers?.['x-nx-cache-outcome']).toBe('disabled');
      expect(authenticate).not.toHaveBeenCalled();
    },
  );
});

describe('unexpected errors', () => {
  it.each(['GET', 'PUT'])('never fail the caller on %s', async (method) => {
    const { call, records } = setup({ get: new TypeError('boom'), put: new TypeError('boom') });
    const res = await call(method === 'PUT' ? putEvent(Buffer.from('x')) : {});
    expect(res.statusCode).toBe(method === 'GET' ? 404 : 403);
    expect(records[0]).toMatchObject({
      outcome: 'internal_error',
      errorCode: 'TypeError',
      reason: 'boom',
    });
  });
});

describe('request record (07, LOG-1 and LOG-2)', () => {
  it('records one line per request with request context and no token or body', async () => {
    const { call, records } = setup();
    await call(putEvent(Buffer.from('secret body bytes')));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      requestId: 'lambda-request-1',
      apiRequestId: 'api-request-1',
      method: 'PUT',
      sourceIp: '198.51.100.7',
      userAgent: 'nx-test',
      tokenHash8: 'abcdef01',
      authCache: 'miss',
      stsMs: 40,
      durationMs: expect.any(Number),
    });
    const text = JSON.stringify(records[0]);
    expect(text).not.toContain(TOKEN.slice(7));
    expect(text).not.toContain('secret body bytes');
    expect(text).not.toContain(Buffer.from('secret body bytes').toString('base64'));
  });
});
