// SPIKE-2 (08 §1), kept as part of the end-to-end suite: behaviour that only a
// real API Gateway in front of the handler can show.
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { config, get, put, randomHash, send, tokenFor, workspaceId } from './support.js';

const MIB = 1024 * 1024;

describe.skipIf(!config)('SPIKE-2', () => {
  const ws = config ? workspaceId('spike2') : '';
  let token: string;

  beforeAll(async () => {
    token = await tokenFor(config!.allowedProfile);
  });

  describe('SP2-1: byte-for-byte round trips (03, APIGW-4)', () => {
    const sizes = config ? [0, 1, MIB, config.maxArtifactBytes] : [];
    it.each(sizes)('%i bytes', async (size) => {
      const hash = randomHash();
      const body = randomBytes(size);
      const stored = await put(ws, hash, body, token);
      expect(stored.status, await stored.text()).toBe(200);
      const hit = await get(ws, hash, token);
      expect(hit.status).toBe(200);
      expect(hit.headers.get('content-type')).toBe('application/octet-stream');
      expect(Buffer.from(await hit.arrayBuffer()).equals(body)).toBe(true);
      // Records are immutable (01, CON-3).
      expect((await put(ws, hash, randomBytes(size), token)).status).toBe(409);
    });
  });

  describe('SP2-2: plain-text responses from the gateway (03, APIGW-5)', () => {
    it('answers an unknown route with 404 "Not found"', async () => {
      const res = await send(`${config!.url}/${ws}/v2/cache/1`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(await res.text()).toBe('Not found');
    });

    it("answers a body over API Gateway's 10 MB limit with 403, a skipped upload (D-36)", async () => {
      const res = await put(ws, randomHash(), randomBytes(11 * MIB), token);
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(await res.text()).toContain('too large');
    });
  });

  describe('SP2-3: bodies the Lambda event cannot hold (03, SIZE-3; D-36)', () => {
    it.each([5 * MIB, 8 * MIB])('rejects %i bytes at the size gate with 403', async (size) => {
      const res = await put(ws, randomHash(), randomBytes(size), token);
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(await res.text()).toContain('too large');
    });

    it('rejects one byte over the limit in the handler or the gate', async () => {
      const res = await put(ws, randomHash(), randomBytes(config!.maxArtifactBytes + 1), token);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('too large');
    });
  });

  describe('statuses Nx tolerates (D-34)', () => {
    it('answers GET without a token as a miss', async () => {
      const res = await get(ws, randomHash());
      expect(res.status).toBe(404);
      expect(res.headers.get('x-nx-cache-outcome')).toBe('unauthenticated');
    });

    it('answers PUT without a token as a skipped upload', async () => {
      const res = await put(ws, randomHash(), Buffer.from('x'));
      expect(res.status).toBe(403);
      expect(res.headers.get('x-nx-cache-outcome')).toBe('unauthenticated');
      expect(await res.text()).toContain('aws sso login');
    });

    it('answers an invalid hash as a miss', async () => {
      const res = await get(ws, 'not.a.hash', token);
      expect(res.status).toBe(404);
      expect(res.headers.get('x-nx-cache-outcome')).toBe('bad_request');
    });
  });
});
