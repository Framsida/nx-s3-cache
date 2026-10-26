// Request handling (03 §5). Cheap checks run first, and nothing about a
// record's existence is revealed before authorization succeeds.
//
// Status codes follow D-34. SPIKE-1 showed that Nx fails the whole command on
// any GET status other than 200 or 404, and on any PUT status other than 200,
// 403 or 409. So every request the handler cannot serve is answered as a miss
// (GET 404) or a skipped upload (PUT 403, with a text/plain reason). What
// actually happened is in the x-nx-cache-outcome header, the log line and the
// metrics.
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import {
  HASH_PATTERN,
  OUTCOME_HEADER,
  WORKSPACE_PATTERN,
  type Outcome,
} from '@nx-s3-serverless-cache/token-format';
import type { Authenticator } from './auth.js';
import type { Config } from './config.js';
import { isAllowed } from './roles.js';
import type { S3Storage } from './storage.js';
import type { Emit, RequestRecord } from './telemetry.js';

export const ROUTE_RESOURCE = '/{workspace}/v1/cache/{hash}';

export interface HandlerDeps {
  config: Config;
  authenticator: Pick<Authenticator, 'authenticate'>;
  storage: Pick<S3Storage, 'get' | 'put'>;
  emit: Emit;
  now?: () => number;
}

export type Handler = (
  event: APIGatewayProxyEvent,
  context: Pick<Context, 'awsRequestId'>,
) => Promise<APIGatewayProxyResult>;

const MIB = 1024 * 1024;

/** Messages for the CLI user (03, table 5.4). No internal detail (01, CON-7). */
export const MESSAGES = {
  bad_request: 'Invalid cache request',
  length_required: 'Content-Length is required',
  unauthenticated: 'Nx cache: AWS credentials missing or expired. Run "aws sso login" and retry.',
  forbidden: 'Nx cache: your AWS role is not allowed to use this cache.',
  upstream_error: 'Nx cache is temporarily unavailable',
  internal_error: 'Nx cache is temporarily unavailable',
  disabled: 'Nx cache is disabled by its operator',
} as const;

export function oversizeMessage(bytes: number, limit: number): string {
  const mb = (n: number) => (n / MIB).toFixed(1);
  return `Nx cache: task output is ${mb(bytes)} MB; the limit is ${mb(limit)} MB. It was not cached remotely.`;
}

/** Case-insensitive header lookup. Repeated headers with different values count as absent. */
function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  const multi = Object.entries(event.multiValueHeaders ?? {}).find(
    ([k]) => k.toLowerCase() === name,
  )?.[1];
  if (multi && new Set(multi).size > 1) return undefined;
  return (
    Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1] ?? undefined
  );
}

function route(event: APIGatewayProxyEvent): { workspace: string; hash: string } | undefined {
  if (event.resource !== ROUTE_RESOURCE) return undefined;
  const workspace = event.pathParameters?.workspace;
  const hash = event.pathParameters?.hash;
  return workspace !== undefined && hash !== undefined ? { workspace, hash } : undefined;
}

const respond = (
  statusCode: number,
  outcome: Outcome,
  extra: Partial<APIGatewayProxyResult> = {},
): APIGatewayProxyResult => ({
  statusCode,
  headers: { [OUTCOME_HEADER]: outcome, ...(extra.headers ?? {}) },
  body: extra.body ?? '',
  ...(extra.isBase64Encoded ? { isBase64Encoded: true } : {}),
});

/** A miss: no body (01, CON-5). */
const miss = (outcome: Outcome) => respond(404, outcome);

/** A skipped upload: Nx carries on (D-34). */
const skipped = (outcome: Outcome, message: string) =>
  respond(403, outcome, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: message,
  });

export function createHandler(deps: HandlerDeps): Handler {
  const { config, authenticator, storage, emit } = deps;
  const now = deps.now ?? Date.now;

  return async (event, context) => {
    const started = now();
    const method = event.httpMethod;
    const record: Omit<RequestRecord, 'outcome' | 'status' | 'durationMs'> = {
      requestId: context.awsRequestId,
      apiRequestId: event.requestContext?.requestId,
      method,
      sourceIp: event.requestContext?.identity?.sourceIp,
      userAgent: header(event, 'user-agent')?.slice(0, 256),
      authorized: false,
    };

    const finish = (
      outcome: Outcome,
      response: APIGatewayProxyResult,
      extra: Partial<RequestRecord> = {},
    ): APIGatewayProxyResult => {
      emit({
        ...record,
        ...extra,
        outcome,
        status: response.statusCode,
        durationMs: now() - started,
      });
      return response;
    };

    // Step 1: method and route.
    const path = route(event);
    if ((method !== 'GET' && method !== 'PUT') || !path) {
      return finish('bad_request', miss('bad_request'), { reason: 'unknown route' });
    }
    const fail = (
      outcome: Exclude<Outcome, 'hit' | 'miss' | 'stored' | 'exists'>,
      message: string,
    ) => (method === 'GET' ? miss(outcome) : skipped(outcome, message));

    try {
      // Step 2: workspace and hash syntax (01, CON-2; 03, WS-1).
      if (!WORKSPACE_PATTERN.test(path.workspace) || !HASH_PATTERN.test(path.hash)) {
        return finish('bad_request', fail('bad_request', MESSAGES.bad_request), {
          reason: 'invalid workspace or hash',
        });
      }
      record.workspace = path.workspace;
      record.hash = path.hash;

      if (!config.cacheEnabled) return finish('disabled', fail('disabled', MESSAGES.disabled));

      // Step 3: declared size, before authentication (03, SIZE-2).
      let declared = 0;
      if (method === 'PUT') {
        const length = header(event, 'content-length');
        if (length === undefined) {
          return finish('bad_request', fail('bad_request', MESSAGES.length_required), {
            reason: 'no Content-Length',
          });
        }
        if (!/^\d{1,10}$/.test(length)) {
          return finish('bad_request', fail('bad_request', MESSAGES.bad_request), {
            reason: 'invalid Content-Length',
          });
        }
        declared = Number(length);
        if (declared > config.maxArtifactBytes) {
          return finish(
            'oversize',
            fail('oversize', oversizeMessage(declared, config.maxArtifactBytes)),
            {
              bytes: declared,
            },
          );
        }
      }

      // Step 4: authenticate (02 §4).
      const auth = await authenticator.authenticate(header(event, 'authorization'));
      record.tokenHash8 = auth.tokenHash8;
      if (auth.stsMs !== undefined) record.stsMs = auth.stsMs;
      if (!auth.ok) {
        return finish(auth.outcome, fail(auth.outcome, MESSAGES[auth.outcome]), {
          reason: auth.reason,
          errorCode: auth.errorCode,
          awsRequestId: auth.awsRequestId,
          ...(auth.outcome === 'upstream_error' ? { upstream: 'sts' as const } : {}),
        });
      }
      record.principal = auth.identity.principal;
      record.authCache = auth.authCache;
      if (auth.identity.kind === 'role') record.session = auth.identity.session;

      // Step 5: authorize (02, AUTHZ-1 and AUTHZ-4).
      if (!isAllowed(auth.identity, config.allowedRoles, method === 'GET' ? 'read' : 'write')) {
        return finish('forbidden', fail('forbidden', MESSAGES.forbidden), {
          reason: 'role not on the allowed list',
        });
      }
      record.authorized = true;

      // Step 6: storage.
      if (method === 'GET') {
        const result = await storage.get(path.workspace, path.hash);
        record.s3Ms = result.s3Ms;
        if (result.kind === 'hit') {
          return finish(
            'hit',
            respond(200, 'hit', {
              headers: { 'content-type': 'application/octet-stream' },
              body: result.body.toString('base64'),
              isBase64Encoded: true,
            }),
            { bytes: result.body.length },
          );
        }
        if (result.kind === 'miss') return finish('miss', miss('miss'));
        return finish('upstream_error', miss('upstream_error'), {
          upstream: 's3',
          errorCode: result.errorCode,
          awsRequestId: result.awsRequestId,
        });
      }

      const body = Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf8');
      if (body.length !== declared) {
        return finish('bad_request', fail('bad_request', MESSAGES.bad_request), {
          reason: `body is ${body.length} bytes, Content-Length is ${declared}`,
        });
      }
      const writer = { principal: auth.identity.principal, session: record.session ?? '' };
      const result = await storage.put(path.workspace, path.hash, body, writer);
      record.s3Ms = result.s3Ms;
      if (result.kind === 'stored')
        return finish('stored', respond(200, 'stored'), { bytes: body.length });
      if (result.kind === 'exists') return finish('exists', respond(409, 'exists'));
      return finish('upstream_error', skipped('upstream_error', MESSAGES.upstream_error), {
        upstream: 's3',
        errorCode: result.errorCode,
        awsRequestId: result.awsRequestId,
      });
    } catch (err) {
      // A bug must not fail the caller's build either.
      return finish('internal_error', fail('internal_error', MESSAGES.internal_error), {
        errorCode: (err as Error).name?.slice(0, 64) ?? 'Error',
        reason: (err as Error).message?.slice(0, 200),
      });
    }
  };
}
