// CT-1: every response the handler produces is checked against the Nx OpenAPI
// document: status, content type and body shape (01, CON-1).
import { readFileSync } from 'node:fs';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '../src/auth.js';
import { createHandler } from '../src/handler.js';
import { normalizeIdentity } from '../src/roles.js';
import type { GetResult, PutResult } from '../src/storage.js';
import { CONTEXT, makeEvent, testConfig, type EventOptions } from './helpers.js';

interface OpenApiResponse {
  description: string;
  content?: Record<string, { schema: { type: string; format?: string } }>;
}
interface OpenApi {
  paths: Record<string, Record<'get' | 'put', { responses: Record<string, OpenApiResponse> }>>;
}

const spec = JSON.parse(
  readFileSync(
    new URL('../../../docs/specs/nx-remote-cache.openapi.json', import.meta.url),
    'utf8',
  ),
) as OpenApi;
const operations = spec.paths['/v1/cache/{hash}']!;

const allowed: AuthResult = {
  ok: true,
  identity: normalizeIdentity('arn:aws:sts::111111111111:assumed-role/ci-runner/s'),
  tokenHash8: '00000000',
  authCache: 'miss',
};
const forbidden: AuthResult = {
  ...allowed,
  identity: normalizeIdentity('arn:aws:sts::999999999999:assumed-role/x/s'),
};
const unauthenticated: AuthResult = { ok: false, outcome: 'unauthenticated', reason: 'test' };
const stsDown: AuthResult = { ok: false, outcome: 'upstream_error', reason: 'test' };
const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);

interface Scenario {
  name: string;
  event: EventOptions;
  auth?: AuthResult;
  get?: GetResult;
  put?: PutResult;
  cacheEnabled?: boolean;
}

const put = (extra: Partial<EventOptions> = {}): EventOptions => ({
  method: 'PUT',
  body,
  headers: { Authorization: 'Bearer x', 'Content-Length': String(body.length) },
  ...extra,
});

const scenarios: Scenario[] = [
  { name: 'GET hit', event: {}, get: { kind: 'hit', body, s3Ms: 1 } },
  { name: 'GET miss', event: {} },
  { name: 'GET bad hash', event: { hash: '..' } },
  { name: 'GET unauthenticated', event: {}, auth: unauthenticated },
  { name: 'GET forbidden', event: {}, auth: forbidden },
  { name: 'GET STS unavailable', event: {}, auth: stsDown },
  { name: 'GET S3 error', event: {}, get: { kind: 'error', errorCode: 'SlowDown', s3Ms: 1 } },
  { name: 'GET disabled', event: {}, cacheEnabled: false },
  { name: 'PUT stored', event: put() },
  { name: 'PUT exists', event: put(), put: { kind: 'exists', s3Ms: 1 } },
  { name: 'PUT bad hash', event: put({ hash: '..' }) },
  { name: 'PUT no Content-Length', event: put({ headers: { Authorization: 'Bearer x' } }) },
  {
    name: 'PUT oversize',
    event: put({ headers: { Authorization: 'Bearer x', 'Content-Length': '99999999' } }),
  },
  {
    name: 'PUT length mismatch',
    event: put({ headers: { Authorization: 'Bearer x', 'Content-Length': '3' } }),
  },
  { name: 'PUT unauthenticated', event: put(), auth: unauthenticated },
  { name: 'PUT forbidden', event: put(), auth: forbidden },
  { name: 'PUT STS unavailable', event: put(), auth: stsDown },
  { name: 'PUT S3 error', event: put(), put: { kind: 'error', errorCode: 'SlowDown', s3Ms: 1 } },
  { name: 'PUT disabled', event: put(), cacheEnabled: false },
];

async function run(scenario: Scenario): Promise<APIGatewayProxyResult> {
  const handler = createHandler({
    config: testConfig({ cacheEnabled: scenario.cacheEnabled ?? true }),
    authenticator: { authenticate: async () => scenario.auth ?? allowed },
    storage: {
      get: async () => scenario.get ?? { kind: 'miss', s3Ms: 1 },
      put: async () => scenario.put ?? { kind: 'stored', s3Ms: 1 },
    },
    emit: () => {},
  });
  return handler(makeEvent(scenario.event), CONTEXT);
}

function contentType(res: APIGatewayProxyResult): string | undefined {
  const value = Object.entries(res.headers ?? {}).find(
    ([k]) => k.toLowerCase() === 'content-type',
  )?.[1];
  return value === undefined ? undefined : String(value).split(';')[0]!.trim();
}

describe('responses match the Nx OpenAPI document', () => {
  it.each(scenarios)('$name', async (scenario) => {
    const method = (scenario.event.method ?? 'GET').toLowerCase() as 'get' | 'put';
    const res = await run(scenario);
    const documented = operations[method].responses[String(res.statusCode)];
    expect(
      documented,
      `${method.toUpperCase()} ${res.statusCode} is not in the OpenAPI document`,
    ).toBeDefined();

    if (documented!.content) {
      const types = Object.keys(documented!.content);
      expect(types).toContain(contentType(res));
      expect(res.body.length).toBeGreaterThan(0);
      if (contentType(res) === 'application/octet-stream') {
        expect(res.isBase64Encoded).toBe(true);
        expect(Buffer.from(res.body, 'base64')).toEqual(body);
      }
    } else {
      expect(res.body).toBe('');
      expect(contentType(res)).toBeUndefined();
    }
  });

  it('uses only statuses Nx accepts without failing the command (D-34)', async () => {
    const seen = { get: new Set<number>(), put: new Set<number>() };
    for (const scenario of scenarios) {
      const method = (scenario.event.method ?? 'GET').toLowerCase() as 'get' | 'put';
      seen[method].add((await run(scenario)).statusCode);
    }
    expect([...seen.get].sort()).toEqual([200, 404]);
    expect([...seen.put].sort()).toEqual([200, 403, 409]);
  });
});
