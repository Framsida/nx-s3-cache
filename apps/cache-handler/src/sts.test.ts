// Steps 6 and 7 of 02 §4: how STS answers map to results.
import { describe, expect, it, vi } from 'vitest';
import { StsVerifier, type StsTransport } from './sts.js';

const URL_ = 'https://sts.eu-west-1.amazonaws.com/?Action=GetCallerIdentity';

function reply(status: number, body: string, headers: Record<string, string> = {}): StsTransport {
  return async () => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  });
}

const identity = JSON.stringify({
  GetCallerIdentityResponse: {
    GetCallerIdentityResult: {
      Account: '111111111111',
      Arn: 'arn:aws:sts::111111111111:assumed-role/ci-runner/s',
      UserId: 'AROAEXAMPLE:s',
    },
  },
});

describe('StsVerifier', () => {
  it('sends the audience and Accept headers to the given URL', async () => {
    const transport = vi.fn(reply(200, identity));
    await new StsVerifier('nx-cache.example.com', { transport }).verify(URL_);
    expect(transport).toHaveBeenCalledWith(URL_, {
      headers: { 'x-nx-cache-audience': 'nx-cache.example.com', accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
  });

  it('returns the identity from a 200', async () => {
    const result = await new StsVerifier('a', {
      transport: reply(200, identity, { 'x-amzn-requestid': 'r1' }),
    }).verify(URL_);
    expect(result).toEqual({
      ok: true,
      account: '111111111111',
      arn: 'arn:aws:sts::111111111111:assumed-role/ci-runner/s',
      userId: 'AROAEXAMPLE:s',
      awsRequestId: 'r1',
    });
  });

  it.each([
    [
      '403 SignatureDoesNotMatch',
      403,
      '{"Error":{"Code":"SignatureDoesNotMatch"}}',
      'SignatureDoesNotMatch',
    ],
    ['403 ExpiredToken', 403, '{"Error":{"Code":"ExpiredToken"}}', 'ExpiredToken'],
    [
      '400 with an XML error',
      400,
      '<ErrorResponse><Error><Code>InvalidClientTokenId</Code></Error></ErrorResponse>',
      'InvalidClientTokenId',
    ],
  ])('maps %s to rejected (401)', async (_name, status, body, errorCode) => {
    const result = await new StsVerifier('a', { transport: reply(status, body) }).verify(URL_);
    expect(result).toMatchObject({ ok: false, kind: 'rejected', status, errorCode });
  });

  it.each([
    ['500', 500, '{"Error":{"Code":"InternalFailure"}}', 'InternalFailure'],
    ['503 without a body', 503, '', 'HTTP503'],
    ['400 Throttling', 400, '{"Error":{"Code":"Throttling"}}', 'Throttling'],
    ['429', 429, '', 'HTTP429'],
    ['a redirect, which is never followed', 307, '', 'HTTP307'],
    ['a 200 that is not an identity', 200, '{"unexpected":true}', 'MalformedResponse'],
    ['a 200 that is not JSON', 200, '<xml/>', 'MalformedResponse'],
  ])('maps %s to unavailable (503)', async (_name, status, body, errorCode) => {
    const result = await new StsVerifier('a', { transport: reply(status, body) }).verify(URL_);
    expect(result).toMatchObject({ ok: false, kind: 'unavailable', errorCode });
  });

  it('maps a network error to unavailable', async () => {
    const transport: StsTransport = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await new StsVerifier('a', { transport }).verify(URL_)).toEqual({
      ok: false,
      kind: 'unavailable',
      errorCode: 'NetworkError',
    });
  });

  it('gives up after the timeout', async () => {
    const transport: StsTransport = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      );
    const result = await new StsVerifier('a', { transport, timeoutMs: 20 }).verify(URL_);
    expect(result).toEqual({ ok: false, kind: 'unavailable', errorCode: 'Timeout' });
  });
});
