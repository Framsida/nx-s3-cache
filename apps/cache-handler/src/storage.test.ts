// UT-4: S3 errors map as in 03 §5.2 and §5.3, with the S3 client faked.
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { MemoryS3, s3Error } from '../test/helpers.js';
import { objectKey, S3Storage } from './storage.js';

const BUCKET = 'nx-cache-test-artifacts-111111111111';
const writer = { principal: 'role:111111111111:ci-runner', session: 'build-7' };

function storageWith(error?: Error) {
  const s3 = new MemoryS3();
  s3.failWith = error;
  return { s3, storage: new S3Storage(s3, BUCKET) };
}

describe('objectKey', () => {
  it('puts each workspace under its own v1 prefix (04, KEY-1)', () => {
    expect(objectKey('web-platform', '123')).toBe('v1/web-platform/123');
  });
});

describe('get', () => {
  it('returns the stored bytes', async () => {
    const { s3, storage } = storageWith();
    s3.objects.set('v1/ws/1', { body: Buffer.from([0, 1, 2, 255]), metadata: {} });
    const result = await storage.get('ws', '1');
    expect(result).toMatchObject({ kind: 'hit', body: Buffer.from([0, 1, 2, 255]) });
    const command = s3.commands[0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: 'v1/ws/1' });
  });

  it('maps NoSuchKey to a miss', async () => {
    expect(await storageWith(s3Error('NoSuchKey', 404)).storage.get('ws', '1')).toMatchObject({
      kind: 'miss',
    });
  });

  it('maps a bare 404 to a miss', async () => {
    expect(await storageWith(s3Error('NotFound', 404)).storage.get('ws', '1')).toMatchObject({
      kind: 'miss',
    });
  });

  it.each([
    ['NoSuchBucket', 404],
    ['AccessDenied', 403],
    ['SlowDown', 503],
    ['InternalError', 500],
    ['TimeoutError', 0],
  ])('maps %s to an upstream error with the request ID', async (name, status) => {
    expect(await storageWith(s3Error(name, status)).storage.get('ws', '1')).toMatchObject({
      kind: 'error',
      errorCode: name,
      awsRequestId: 's3-request-1',
    });
  });

  it('refuses objects too large for a Lambda response (03, SIZE-4)', async () => {
    const { s3, storage } = storageWith();
    s3.objects.set('v1/ws/1', { body: Buffer.alloc(4_500_001), metadata: {} });
    expect(await storage.get('ws', '1')).toMatchObject({
      kind: 'error',
      errorCode: 'ObjectTooLarge',
    });
  });
});

describe('put', () => {
  const body = Buffer.from('tarball bytes');

  it('writes conditionally, with a checksum and writer metadata (04 §4)', async () => {
    const { s3, storage } = storageWith();
    expect(await storage.put('ws', '1', body, writer)).toMatchObject({ kind: 'stored' });
    const command = s3.commands[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: BUCKET,
      Key: 'v1/ws/1',
      Body: body,
      ContentLength: body.length,
      ContentType: 'application/octet-stream',
      IfNoneMatch: '*',
      ChecksumAlgorithm: 'SHA256',
      ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
      Metadata: { writer: writer.principal, 'writer-session': 'build-7', 'nx-workspace': 'ws' },
    });
  });

  it('truncates the session name to 64 characters', async () => {
    const { s3, storage } = storageWith();
    await storage.put('ws', '1', body, { ...writer, session: 'x'.repeat(80) });
    expect((s3.commands[0] as PutObjectCommand).input.Metadata?.['writer-session']).toHaveLength(
      64,
    );
  });

  it('maps PreconditionFailed (object exists) to exists', async () => {
    expect(
      await storageWith(s3Error('PreconditionFailed', 412)).storage.put('ws', '1', body, writer),
    ).toMatchObject({ kind: 'exists' });
  });

  it('maps ConditionalRequestConflict (concurrent write) to exists', async () => {
    expect(
      await storageWith(s3Error('ConditionalRequestConflict', 409)).storage.put(
        'ws',
        '1',
        body,
        writer,
      ),
    ).toMatchObject({
      kind: 'exists',
    });
  });

  it.each([
    ['AccessDenied', 403],
    ['BadDigest', 400],
    ['SlowDown', 503],
  ])('maps %s to an upstream error', async (name, status) => {
    expect(
      await storageWith(s3Error(name, status)).storage.put('ws', '1', body, writer),
    ).toMatchObject({
      kind: 'error',
      errorCode: name,
      awsRequestId: 's3-request-1',
    });
  });

  it('never replaces an existing object', async () => {
    const { s3, storage } = storageWith();
    await storage.put('ws', '1', Buffer.from('first'), writer);
    expect(await storage.put('ws', '1', Buffer.from('second'), writer)).toMatchObject({
      kind: 'exists',
    });
    expect(s3.objects.get('v1/ws/1')?.body.toString()).toBe('first');
  });
});
