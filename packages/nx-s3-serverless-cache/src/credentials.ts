// AWS credentials from the SDK v3 default provider chain (05, step 3): env
// variables, IAM Identity Center, shared config, container credentials, EC2
// instance metadata and web identity.
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { AwsCredentialIdentity } from '@smithy/types';

export type ResolveCredentials = (profile: string | undefined) => Promise<AwsCredentialIdentity>;

/** Credential resolution and signing must finish within 5 seconds (05, PL-3). */
export const CREDENTIALS_TIMEOUT_MS = 5000;

export class CredentialsTimeoutError extends Error {
  override name = 'CredentialsTimeoutError';
}

export const resolveDefaultCredentials: ResolveCredentials = (profile) =>
  defaultProvider(profile ? { profile } : {})();

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CredentialsTimeoutError(`no answer within ${ms / 1000} s`)),
      ms,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Where the credentials came from, for verbose logs only (05, PL-5). */
export function credentialSource(
  credentials: AwsCredentialIdentity,
  profile: string | undefined,
): string {
  const features = Object.keys((credentials as { $source?: Record<string, string> }).$source ?? {});
  const named = features
    .find((f) => f.startsWith('CREDENTIALS_'))
    ?.replace(/^CREDENTIALS_/, '')
    .toLowerCase();
  return named ?? (profile ? `profile ${profile}` : 'default provider chain');
}

/** An actionable sentence for a credential failure (05, PL-2). */
export function describeCredentialError(err: unknown, profile: string | undefined): string {
  const login = profile ? `aws sso login --profile ${profile}` : 'aws sso login';
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof CredentialsTimeoutError) {
    return `AWS credentials took longer than ${CREDENTIALS_TIMEOUT_MS / 1000} s to resolve.`;
  }
  if (/sso|token.*expired|expired.*token|refresh/i.test(message)) {
    return `your AWS SSO session has expired. Run "${login}".`;
  }
  if (
    /could not load credentials|no credentials|unable to find|profile .* could not be found/i.test(
      message,
    )
  ) {
    return `no AWS credentials found. Run "${login}".`;
  }
  return `could not get AWS credentials (${message.split('\n')[0]?.slice(0, 200)}).`;
}
