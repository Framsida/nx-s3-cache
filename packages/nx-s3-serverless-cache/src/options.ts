// Plugin options from nx.json (05 §2), validated once per run (05, CFG-1).
import {
  DEFAULT_TOKEN_LIFETIME_SECONDS,
  REGION_PATTERN,
  WORKSPACE_PATTERN,
} from '@nx-s3-serverless-cache/token-format';

export interface PluginOptions {
  url?: string;
  workspace?: string;
  region?: string;
  audience?: string;
  profile?: string;
  tokenLifetimeSeconds?: number;
}

export interface ResolvedOptions {
  /** Base URL without a trailing slash. */
  url: string;
  workspace: string;
  region: string;
  audience: string;
  profile?: string;
  tokenLifetimeSeconds: number;
  /** Value for NX_SELF_HOSTED_REMOTE_CACHE_SERVER (03, URL-1). */
  serverUrl: string;
}

export type OptionsResult = { ok: true; options: ResolvedOptions } | { ok: false; error: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_LIFETIME_SECONDS = 43_200;

function parseUrl(value: unknown): URL | string {
  if (typeof value !== 'string' || value === '') return '"url" is required';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `"url" is not a URL: ${value}`;
  }
  // Plain HTTP only for local test servers.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return `"url" must use https: ${value}`;
  }
  if (url.username || url.password || url.search || url.hash) {
    return `"url" must not contain credentials, a query or a fragment: ${value}`;
  }
  // SPIKE-1: Nx keeps the path of the server URL, so a trailing slash becomes
  // "//v1/cache". The workspace is the only path segment (03, URL-1).
  if (url.pathname.replace(/\/+$/, '') !== '') return `"url" must not have a path: ${value}`;
  return url;
}

export function resolveOptions(raw: unknown): OptionsResult {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || Array.isArray(input))
    return { ok: false, error: 'plugin options must be an object' };

  const url = parseUrl(input.url);
  if (typeof url === 'string') return { ok: false, error: url };

  const { workspace, region, audience, profile, tokenLifetimeSeconds } = input;
  if (typeof workspace !== 'string' || !WORKSPACE_PATTERN.test(workspace)) {
    return {
      ok: false,
      error: `"workspace" must be 1 to 63 lowercase letters, digits or hyphens, got ${JSON.stringify(workspace)}`,
    };
  }
  if (typeof region !== 'string' || !REGION_PATTERN.test(region)) {
    return {
      ok: false,
      error: `"region" must be an AWS region such as eu-west-1, got ${JSON.stringify(region)}`,
    };
  }
  if (
    audience !== undefined &&
    (typeof audience !== 'string' || !/^[\x21-\x7e]{1,253}$/.test(audience))
  ) {
    return { ok: false, error: `"audience" must be a host name, got ${JSON.stringify(audience)}` };
  }
  if (profile !== undefined && (typeof profile !== 'string' || !/^\S{1,128}$/.test(profile))) {
    return {
      ok: false,
      error: `"profile" must be an AWS profile name, got ${JSON.stringify(profile)}`,
    };
  }
  const lifetime = tokenLifetimeSeconds ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
  if (
    typeof lifetime !== 'number' ||
    !Number.isInteger(lifetime) ||
    lifetime < 60 ||
    lifetime > MAX_LIFETIME_SECONDS
  ) {
    return {
      ok: false,
      error: `"tokenLifetimeSeconds" must be an integer from 60 to ${MAX_LIFETIME_SECONDS}, got ${JSON.stringify(tokenLifetimeSeconds)}`,
    };
  }

  const base = url.origin;
  return {
    ok: true,
    options: {
      url: base,
      workspace,
      region,
      // Defaults to the url's host (02, TOK-1).
      audience: (audience as string | undefined) ?? url.hostname,
      ...(profile !== undefined ? { profile: profile as string } : {}),
      tokenLifetimeSeconds: lifetime,
      serverUrl: `${base}/${workspace}`,
    },
  };
}
