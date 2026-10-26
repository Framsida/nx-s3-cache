// Authentication (02 §4): token checks, then STS, with successful results cached
// in memory for a short time (02, VAL-3).
import { normalizeIdentity, type Identity } from './roles.js';
import type { StsVerifier } from './sts.js';
import { checkToken, type TokenPolicy } from './token.js';

export type AuthResult =
  | {
      ok: true;
      identity: Identity;
      tokenHash8: string;
      authCache: 'hit' | 'miss';
      stsMs?: number;
    }
  | {
      ok: false;
      outcome: 'unauthenticated' | 'upstream_error';
      reason: string;
      tokenHash8?: string;
      stsMs?: number;
      errorCode?: string;
      awsRequestId?: string;
    };

interface CacheEntry {
  identity: Identity;
  expiresAt: number;
}

export interface AuthenticatorOptions extends TokenPolicy {
  verifier: Pick<StsVerifier, 'verify'>;
  now?: () => number;
  /** At most 5 minutes (02, VAL-3). */
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

export class Authenticator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;

  constructor(private readonly options: AuthenticatorOptions) {
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = Math.min(options.cacheTtlMs ?? 5 * 60 * 1000, 5 * 60 * 1000);
    this.maxCacheEntries = options.maxCacheEntries ?? 1000;
  }

  async authenticate(authorization: string | undefined): Promise<AuthResult> {
    const now = this.now();
    const check = checkToken(authorization, this.options, now);
    if (!check.ok) {
      return {
        ok: false,
        outcome: 'unauthenticated',
        reason: check.reason,
        tokenHash8: check.tokenHash?.slice(0, 8),
      };
    }
    const { token } = check;
    const tokenHash8 = token.tokenHash.slice(0, 8);

    const cached = this.cache.get(token.tokenHash);
    if (cached && now < cached.expiresAt) {
      return { ok: true, identity: cached.identity, tokenHash8, authCache: 'hit' };
    }
    if (cached) this.cache.delete(token.tokenHash);

    const started = this.now();
    const result = await this.options.verifier.verify(token.url);
    const stsMs = this.now() - started;
    if (!result.ok) {
      const { errorCode, awsRequestId } = result;
      return result.kind === 'rejected'
        ? {
            ok: false,
            outcome: 'unauthenticated',
            reason: 'STS rejected the token',
            tokenHash8,
            stsMs,
            errorCode,
            awsRequestId,
          }
        : {
            ok: false,
            outcome: 'upstream_error',
            reason: 'STS unavailable',
            tokenHash8,
            stsMs,
            errorCode,
            awsRequestId,
          };
    }

    const identity = normalizeIdentity(result.arn);
    this.remember(token.tokenHash, identity, Math.min(now + this.cacheTtlMs, token.expiresAt));
    return { ok: true, identity, tokenHash8, authCache: 'miss', stsMs };
  }

  private remember(tokenHash: string, identity: Identity, expiresAt: number): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const now = this.now();
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(key);
      }
      // Still full: drop the oldest entry (Map keeps insertion order).
      if (this.cache.size >= this.maxCacheEntries) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    this.cache.set(tokenHash, { identity, expiresAt });
  }
}
