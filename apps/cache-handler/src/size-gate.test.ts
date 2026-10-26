// The PUT size gate (D-36).
import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { collector } from '../test/helpers.js';
import { createSizeGate, isAuthorizerEvent } from './size-gate.js';

const METHOD_ARN = 'arn:aws:execute-api:eu-west-1:111111111111:abc123/live/PUT/web/v1/cache/42';

function event(headers: Record<string, string>): APIGatewayRequestAuthorizerEvent {
  return {
    type: 'REQUEST',
    methodArn: METHOD_ARN,
    resource: '/{workspace}/v1/cache/{hash}',
    path: '/web/v1/cache/42',
    httpMethod: 'PUT',
    headers,
    multiValueHeaders: {},
    pathParameters: { workspace: 'web', hash: '42' },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {
      requestId: 'api-1',
      identity: { sourceIp: '198.51.100.7' },
    } as APIGatewayRequestAuthorizerEvent['requestContext'],
  };
}

const effect = (result: Awaited<ReturnType<ReturnType<typeof createSizeGate>>>) =>
  result.policyDocument.Statement[0] as { Effect: string; Resource: string };

describe('size gate', () => {
  it('recognises authorizer events and nothing else', () => {
    expect(isAuthorizerEvent(event({}))).toBe(true);
    expect(isAuthorizerEvent({ httpMethod: 'PUT', resource: '/x' })).toBe(false);
    expect(isAuthorizerEvent(null)).toBe(false);
  });

  it('allows an upload up to the limit, for this method only', async () => {
    const { records, emit } = collector();
    const result = await createSizeGate({ maxArtifactBytes: 100 }, emit)(
      event({ 'Content-Length': '100' }),
      { awsRequestId: 'r1' },
    );
    expect(effect(result)).toEqual({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: METHOD_ARN,
    });
    expect(records).toHaveLength(0);
  });

  it('denies an upload over the limit and records it as oversize', async () => {
    const { records, emit } = collector();
    const result = await createSizeGate({ maxArtifactBytes: 100 }, emit)(
      event({ 'content-length': '7000000' }),
      { awsRequestId: 'r1' },
    );
    expect(effect(result).Effect).toBe('Deny');
    expect(records).toEqual([
      expect.objectContaining({
        outcome: 'oversize',
        status: 403,
        bytes: 7000000,
        method: 'PUT',
        requestId: 'r1',
        authorized: false,
      }),
    ]);
  });

  it.each([[{}], [{ 'Content-Length': 'abc' }]])(
    'leaves a missing or malformed length to the handler (%j)',
    async (headers) => {
      const result = await createSizeGate({ maxArtifactBytes: 100 }, () => {})(event(headers), {
        awsRequestId: 'r1',
      });
      expect(effect(result).Effect).toBe('Allow');
    },
  );
});
