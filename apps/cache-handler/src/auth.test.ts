// Authentication results and the in-memory cache (02, VAL-3 and VAL-4).
import { describe, expect, it, vi } from 'vitest';
import { bearer, NOW, REGION } from '../test/helpers.js';
import { Authenticator } from './auth.js';
import type { StsResult } from './sts.js';

const ok: StsResult = {
  ok: true,
  account: '111111111111',
  arn: 'arn:aws:sts::111111111111:assumed-role/ci-runner/build-7',
  userId: 'AROAEXAMPLE:build-7',
};

function setup(results: StsResult[], options: { tokenLifetime?: number } = {}) {
  let now = NOW;
  const verify = vi.fn(async () => results.shift() ?? ok);
  const authenticator = new Authenticator({
    region: REGION,
    maxLifetimeSeconds: 3600,
    verifier: { verify },
    now: () => now,
  });
  return {
    authenticator,
    verify,
    advance: (ms: number) => (now += ms),
    token: () => bearer({ expiresIn: options.tokenLifetime ?? 3600 }),
  };
}

describe('Authenticator', () => {
  it('returns the normalized identity', async () => {
    const { authenticator, token } = setup([ok]);
    expect(await authenticator.authenticate(await token())).toMatchObject({
      ok: true,
      identity: { kind: 'role', principal: 'role:111111111111:ci-runner', session: 'build-7' },
      authCache: 'miss',
      tokenHash8: expect.stringMatching(/^[0-9a-f]{8}$/),
    });
  });

  it('rejects a malformed token without calling STS', async () => {
    const { authenticator, verify } = setup([]);
    expect(await authenticator.authenticate('Bearer junk')).toMatchObject({
      ok: false,
      outcome: 'unauthenticated',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('serves a repeated token from the cache for up to 5 minutes', async () => {
    const { authenticator, verify, advance, token } = setup([ok]);
    const header = await token();
    await authenticator.authenticate(header);
    advance(5 * 60 * 1000 - 1);
    expect(await authenticator.authenticate(header)).toMatchObject({ ok: true, authCache: 'hit' });
    expect(verify).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await authenticator.authenticate(header)).toMatchObject({ ok: true, authCache: 'miss' });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('never serves a cached result past the token expiry', async () => {
    const { authenticator, advance, token } = setup([ok], { tokenLifetime: 120 });
    const header = await token();
    await authenticator.authenticate(header);
    advance(121_000);
    expect(await authenticator.authenticate(header)).toMatchObject({
      ok: false,
      reason: 'token expired',
    });
  });

  it('maps an STS rejection to unauthenticated and does not cache it', async () => {
    const { authenticator, verify, token } = setup([
      { ok: false, kind: 'rejected', status: 403, errorCode: 'SignatureDoesNotMatch' },
      { ok: false, kind: 'rejected', status: 403, errorCode: 'SignatureDoesNotMatch' },
    ]);
    const header = await token();
    expect(await authenticator.authenticate(header)).toMatchObject({
      ok: false,
      outcome: 'unauthenticated',
      errorCode: 'SignatureDoesNotMatch',
    });
    await authenticator.authenticate(header);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('fails closed when STS is unavailable', async () => {
    const { authenticator, token } = setup([
      { ok: false, kind: 'unavailable', errorCode: 'Timeout' },
    ]);
    expect(await authenticator.authenticate(await token())).toMatchObject({
      ok: false,
      outcome: 'upstream_error',
      errorCode: 'Timeout',
    });
  });

  it('keeps the cache bounded', async () => {
    let now = NOW;
    const verify = vi.fn(async () => ok);
    const authenticator = new Authenticator({
      region: REGION,
      maxLifetimeSeconds: 3600,
      verifier: { verify },
      now: () => now,
      maxCacheEntries: 2,
    });
    const headers = [
      await bearer({ signedAt: NOW }),
      await bearer({ signedAt: NOW - 1000 }),
      await bearer({ signedAt: NOW - 2000 }),
    ];
    for (const h of headers) await authenticator.authenticate(h);
    now += 1;
    // The oldest entry was dropped to make room for the third.
    expect((await authenticator.authenticate(headers[0]!)).ok && verify.mock.calls.length).toBe(4);
    expect(await authenticator.authenticate(headers[2]!)).toMatchObject({ authCache: 'hit' });
  });
});
