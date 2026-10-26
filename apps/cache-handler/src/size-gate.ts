// The upload size gate (D-36). API Gateway runs it as a REQUEST authorizer on
// PUT only, before it forwards the body. A body too large for the 6 MB Lambda
// event would otherwise never reach the handler and API Gateway would answer
// with a 5xx, which fails the Nx command (SPIKE-1). A denial here becomes a
// 403, a skipped upload, because the gateway's authorizer responses can only
// happen on PUT. Authentication still happens in the handler.
import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import type { Config } from './config.js';
import type { Emit } from './telemetry.js';

export function isAuthorizerEvent(event: unknown): event is APIGatewayRequestAuthorizerEvent {
  const e = event as { type?: unknown; methodArn?: unknown };
  return e?.type === 'REQUEST' && typeof e.methodArn === 'string';
}

function declaredLength(event: APIGatewayRequestAuthorizerEvent): string | undefined {
  return Object.entries(event.headers ?? {}).find(
    ([k]) => k.toLowerCase() === 'content-length',
  )?.[1];
}

export function createSizeGate(
  config: Pick<Config, 'maxArtifactBytes'>,
  emit: Emit,
  now: () => number = Date.now,
) {
  return async (
    event: APIGatewayRequestAuthorizerEvent,
    context: { awsRequestId: string },
  ): Promise<APIGatewayAuthorizerResult> => {
    const started = now();
    const length = declaredLength(event);
    const declared = length !== undefined && /^\d{1,10}$/.test(length) ? Number(length) : undefined;
    // A missing or malformed length is left to the handler, which answers it
    // with its own message (03, step 3).
    const allow = declared === undefined || declared <= config.maxArtifactBytes;
    if (!allow) {
      emit({
        requestId: context.awsRequestId,
        apiRequestId: event.requestContext?.requestId,
        method: event.httpMethod,
        outcome: 'oversize',
        status: 403,
        bytes: declared,
        durationMs: now() - started,
        sourceIp: event.requestContext?.identity?.sourceIp,
        reason: 'rejected by the size gate before the body reached the handler',
        authorized: false,
      });
    }
    return {
      principalId: 'nx-cache',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'execute-api:Invoke',
            Effect: allow ? 'Allow' : 'Deny',
            Resource: event.methodArn,
          },
        ],
      },
    };
  };
}
