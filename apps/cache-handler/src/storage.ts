// S3 reads and writes (03 §5.2 and §5.3, 04). Records are immutable: writes are
// conditional, so an existing object is never replaced (01, CON-3).
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ARTIFACT_BYTES_CEILING } from './config.js';

/** The part of S3Client the handler uses; tests pass a fake (08, UT-4). */
export interface S3Sender {
  send(command: GetObjectCommand | PutObjectCommand): Promise<unknown>;
}

export interface Writer {
  principal: string;
  session: string;
}

export interface UpstreamFailure {
  kind: 'error';
  errorCode: string;
  awsRequestId?: string;
  s3Ms: number;
}

export type GetResult =
  { kind: 'hit'; body: Buffer; s3Ms: number } | { kind: 'miss'; s3Ms: number } | UpstreamFailure;

export type PutResult =
  { kind: 'stored'; s3Ms: number } | { kind: 'exists'; s3Ms: number } | UpstreamFailure;

interface S3Error {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number; requestId?: string };
}

interface GetObjectOutput {
  ContentLength?: number;
  Body?: { transformToByteArray(): Promise<Uint8Array> };
}

/** S3 key for a record (04, KEY-1 to KEY-3). Inputs are validated before this. */
export function objectKey(workspace: string, hash: string): string {
  return `v1/${workspace}/${hash}`;
}

function failure(err: unknown, s3Ms: number): UpstreamFailure {
  const e = err as S3Error;
  return {
    kind: 'error',
    errorCode: (e.name ?? e.Code ?? 'UnknownError').slice(0, 64),
    awsRequestId: e.$metadata?.requestId,
    s3Ms,
  };
}

export class S3Storage {
  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
    private readonly now: () => number = Date.now,
  ) {}

  async get(workspace: string, hash: string): Promise<GetResult> {
    const started = this.now();
    try {
      const output = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey(workspace, hash) }),
      )) as GetObjectOutput;
      // Stored objects are never above the ceiling (03, SIZE-4); anything bigger
      // was put there by hand and would not fit in a Lambda response.
      if ((output.ContentLength ?? 0) > ARTIFACT_BYTES_CEILING || !output.Body) {
        return {
          kind: 'error',
          errorCode: output.Body ? 'ObjectTooLarge' : 'EmptyBody',
          s3Ms: this.now() - started,
        };
      }
      const body = Buffer.from(await output.Body.transformToByteArray());
      return { kind: 'hit', body, s3Ms: this.now() - started };
    } catch (err) {
      const s3Ms = this.now() - started;
      const e = err as S3Error;
      const notFound = e.$metadata?.httpStatusCode === 404 && e.name !== 'NoSuchBucket';
      if (e.name === 'NoSuchKey' || notFound) return { kind: 'miss', s3Ms };
      return failure(err, s3Ms);
    }
  }

  async put(workspace: string, hash: string, body: Buffer, writer: Writer): Promise<PutResult> {
    const started = this.now();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey(workspace, hash),
          Body: body,
          ContentLength: body.length,
          ContentType: 'application/octet-stream',
          IfNoneMatch: '*',
          ChecksumAlgorithm: 'SHA256',
          ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
          Metadata: {
            writer: writer.principal,
            'writer-session': writer.session.slice(0, 64),
            'nx-workspace': workspace,
          },
        }),
      );
      return { kind: 'stored', s3Ms: this.now() - started };
    } catch (err) {
      const s3Ms = this.now() - started;
      const e = err as S3Error;
      const status = e.$metadata?.httpStatusCode;
      // 412: the object exists. 409: a concurrent write of the same key won.
      if (e.name === 'PreconditionFailed' || status === 412) return { kind: 'exists', s3Ms };
      if (e.name === 'ConditionalRequestConflict' || status === 409)
        return { kind: 'exists', s3Ms };
      return failure(err, s3Ms);
    }
  }
}
