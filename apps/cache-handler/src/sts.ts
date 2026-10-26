// Steps 6 and 7 of 02 §4: send the caller's presigned GetCallerIdentity request
// to STS and read the identity from the answer. The caller already signed the
// request, so the handler needs no STS permission (02 §2).
import { AUDIENCE_HEADER } from '@nx-s3-serverless-cache/token-format';

export interface StsResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * Sends one request. Production uses `fetch` against the URL it is given, which
 * `checkToken` has already pinned to the regional STS host. Tests inject a
 * transport through the constructor to reach a fake STS (08, IT-1); nothing in
 * the configuration can change the host.
 */
export type StsTransport = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<StsResponse>;

export type StsResult =
  | { ok: true; account: string; arn: string; userId: string; awsRequestId?: string }
  /** STS refused the signature or credentials: 401 (02, step 6). */
  | { ok: false; kind: 'rejected'; status: number; errorCode?: string; awsRequestId?: string }
  /** STS could not answer: 503, fail closed (02, VAL-4). */
  | { ok: false; kind: 'unavailable'; status?: number; errorCode: string; awsRequestId?: string };

const fetchTransport: StsTransport = (url, init) =>
  fetch(url, { ...init, method: 'GET', redirect: 'manual' });

/** STS reports throttling as a 4xx; it says nothing about the caller's token. */
const RETRYABLE_ERROR_CODES = new Set([
  'Throttling',
  'ThrottlingException',
  'RequestLimitExceeded',
]);

interface CallerIdentityBody {
  GetCallerIdentityResponse?: {
    GetCallerIdentityResult?: { Account?: unknown; Arn?: unknown; UserId?: unknown };
  };
}

function errorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { Error?: { Code?: unknown } };
    if (typeof parsed.Error?.Code === 'string') return parsed.Error.Code.slice(0, 64);
  } catch {
    const xml = /<Code>([^<]{1,64})<\/Code>/.exec(body);
    if (xml) return xml[1];
  }
  return undefined;
}

export class StsVerifier {
  private readonly transport: StsTransport;
  private readonly timeoutMs: number;

  constructor(
    private readonly audience: string,
    options: { timeoutMs?: number; transport?: StsTransport } = {},
  ) {
    this.transport = options.transport ?? fetchTransport;
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  async verify(url: string): Promise<StsResult> {
    let response: StsResponse;
    let body: string;
    try {
      response = await this.transport(url, {
        headers: { [AUDIENCE_HEADER]: this.audience, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = await response.text();
    } catch (err) {
      const name = (err as Error).name;
      return {
        ok: false,
        kind: 'unavailable',
        errorCode: name === 'TimeoutError' || name === 'AbortError' ? 'Timeout' : 'NetworkError',
      };
    }

    const awsRequestId = response.headers.get('x-amzn-requestid') ?? undefined;
    const code = errorCode(body);
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429 &&
      !RETRYABLE_ERROR_CODES.has(code ?? '')
    ) {
      return {
        ok: false,
        kind: 'rejected',
        status: response.status,
        errorCode: code,
        awsRequestId,
      };
    }
    if (response.status !== 200) {
      // 5xx, throttling, and any redirect (never followed).
      return {
        ok: false,
        kind: 'unavailable',
        status: response.status,
        errorCode: code ?? `HTTP${response.status}`,
        awsRequestId,
      };
    }

    let result: NonNullable<
      CallerIdentityBody['GetCallerIdentityResponse']
    >['GetCallerIdentityResult'];
    try {
      result = (JSON.parse(body) as CallerIdentityBody).GetCallerIdentityResponse
        ?.GetCallerIdentityResult;
    } catch {
      result = undefined;
    }
    const { Account, Arn, UserId } = result ?? {};
    if (
      typeof Account !== 'string' ||
      !/^\d{12}$/.test(Account) ||
      typeof Arn !== 'string' ||
      typeof UserId !== 'string'
    ) {
      return {
        ok: false,
        kind: 'unavailable',
        status: 200,
        errorCode: 'MalformedResponse',
        awsRequestId,
      };
    }
    return { ok: true, account: Account, arn: Arn, userId: UserId, awsRequestId };
  }
}
