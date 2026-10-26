// The nx-s3-serverless-cache CLI (05 §4), kept free of process globals so it
// can be tested. cli.ts wires it to the real process.
import { parseArgs } from 'node:util';
import { OUTCOME_HEADER, PROBE_HASH } from '@nx-s3-serverless-cache/token-format';
import {
  describeCredentialError,
  resolveDefaultCredentials,
  withTimeout,
  type ResolveCredentials,
} from './credentials.js';
import { findPluginOptions, readFileIfExists, type ReadFile } from './nx-json.js';
import { resolveOptions, type ResolvedOptions } from './options.js';
import { SERVER_VARIABLE, TOKEN_VARIABLE } from './plugin.js';
import { createToken, type Token } from './token.js';

/** Exit codes (05, CLI-4). */
export const EXIT = { ok: 0, credentials: 1, config: 2, server: 3 } as const;

export interface CliDeps {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  resolveCredentials: ResolveCredentials;
  now: () => Date;
  fetch: typeof fetch;
  readFile: ReadFile;
  version: string;
}

export const defaultCliDeps = (version: string): CliDeps => ({
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  resolveCredentials: resolveDefaultCredentials,
  now: () => new Date(),
  fetch: globalThis.fetch,
  readFile: readFileIfExists,
  version,
});

export const USAGE = `Usage:
  nx-s3-serverless-cache token [--format token|env|json] [options]
  nx-s3-serverless-cache check [options]

Commands:
  token   Print a cache token made from your AWS credentials.
          --format env prints export lines for both Nx variables:
            eval "$(npx nx-s3-serverless-cache token --format env)"
  check   Check that your AWS role can use the cache.

Options (default to the plugin entry in the nearest nx.json):
  --url <url>            Cache base URL, e.g. https://nx-cache.example.com
  --workspace <id>       Workspace ID
  --region <region>      Region the cache is deployed in
  --audience <value>     Token audience (default: the URL's host)
  --profile <name>       AWS profile
  --lifetime <seconds>   Token lifetime (default: 3600)

Exit codes: 0 success, 1 no credentials or token rejected,
            2 configuration error, 3 server unreachable or failing.`;

const CHECK_TIMEOUT_MS = 15_000;
/** Interactive use can include an SSO refresh, so allow longer than the plugin. */
const CLI_CREDENTIALS_TIMEOUT_MS = 30_000;

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        url: { type: 'string' },
        workspace: { type: 'string' },
        region: { type: 'string' },
        audience: { type: 'string' },
        profile: { type: 'string' },
        lifetime: { type: 'string' },
        format: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (err) {
    deps.stderr(`error: ${(err as Error).message}\n\n${USAGE}`);
    return EXIT.config;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    deps.stdout(deps.version);
    return EXIT.ok;
  }
  const command = positionals[0];
  if (values.help || command === 'help') {
    deps.stdout(USAGE);
    return EXIT.ok;
  }
  if ((command !== 'token' && command !== 'check') || positionals.length > 1) {
    deps.stderr(
      `${command ? `error: unknown command "${positionals.join(' ')}"\n\n` : ''}${USAGE}`,
    );
    return EXIT.config;
  }
  const format = values.format ?? 'token';
  if (command === 'token' && !['token', 'env', 'json'].includes(format)) {
    deps.stderr(`error: --format must be token, env or json, got "${format}"`);
    return EXIT.config;
  }
  if (command === 'check' && values.format !== undefined) {
    deps.stderr('error: --format applies to the token command only');
    return EXIT.config;
  }

  // Flags override the nx.json plugin entry (05, CLI-1).
  const lookup = findPluginOptions(deps.cwd, deps.readFile);
  if (lookup.error) {
    deps.stderr(`error: ${lookup.error}`);
    return EXIT.config;
  }
  const flags = Object.fromEntries(
    Object.entries({
      url: values.url,
      workspace: values.workspace,
      region: values.region,
      audience: values.audience,
      profile: values.profile,
      tokenLifetimeSeconds: values.lifetime === undefined ? undefined : Number(values.lifetime),
    }).filter(([, v]) => v !== undefined),
  );
  const resolved = resolveOptions({ ...lookup.options, ...flags });
  if (!resolved.ok) {
    const where = lookup.path
      ? ` (defaults read from ${lookup.path})`
      : ' (no nx.json found; pass --url, --workspace and --region)';
    deps.stderr(`error: ${resolved.error}${where}`);
    return EXIT.config;
  }
  const options = resolved.options;

  let token: Token;
  try {
    const credentials = await withTimeout(
      deps.resolveCredentials(options.profile),
      CLI_CREDENTIALS_TIMEOUT_MS,
    );
    token = await createToken({
      credentials,
      region: options.region,
      audience: options.audience,
      lifetimeSeconds: options.tokenLifetimeSeconds,
      now: deps.now(),
    });
  } catch (err) {
    deps.stderr(`error: ${describeCredentialError(err, options.profile)}`);
    return EXIT.credentials;
  }

  if (command === 'check') return runCheck(options, token, deps);

  // CLI-2.
  if (format === 'env') {
    deps.stdout(`export ${SERVER_VARIABLE}='${options.serverUrl}'`);
    deps.stdout(`export ${TOKEN_VARIABLE}='${token.token}'`);
  } else if (format === 'json') {
    deps.stdout(
      JSON.stringify({
        token: token.token,
        server: options.serverUrl,
        expiresAt: token.expiresAt.toISOString(),
      }),
    );
  } else {
    deps.stdout(token.token);
  }
  return EXIT.ok;
}

/**
 * CLI-3: GET a hash that is never stored. The handler answers every failure on
 * GET as a 404 (D-34), so the x-nx-cache-outcome header says what happened.
 */
export async function runCheck(
  options: ResolvedOptions,
  token: Token,
  deps: CliDeps,
): Promise<number> {
  const url = `${options.serverUrl}/v1/cache/${PROBE_HASH}`;
  deps.stdout(`Cache:      ${options.serverUrl}`);
  deps.stdout(`Region:     ${options.region}, audience ${options.audience}`);
  deps.stdout(`Token:      valid until ${token.expiresAt.toISOString()}`);

  let response: Response;
  try {
    response = await deps.fetch(url, {
      headers: { authorization: `Bearer ${token.token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    deps.stdout(`Result:     server unreachable (${(err as Error).message})`);
    return EXIT.server;
  }
  const outcome = response.headers.get(OUTCOME_HEADER);
  const status = response.status;
  const detail = `HTTP ${status}${outcome ? `, ${outcome}` : ''}`;

  if (status === 200 || (status === 404 && outcome === 'miss')) {
    deps.stdout(`Result:     authenticated, read allowed (${detail})`);
    deps.stdout(
      'Write access cannot be checked without writing. Every role that can read can also write.',
    );
    return EXIT.ok;
  }
  if (outcome === 'forbidden' || (!outcome && status === 403)) {
    deps.stdout(
      `Result:     authenticated, but your AWS role is not on the cache's allowed list (${detail})`,
    );
    return EXIT.credentials;
  }
  if (outcome === 'unauthenticated' || (!outcome && status === 401)) {
    deps.stdout(
      `Result:     token rejected (${detail}). Check the region and audience, and refresh your AWS credentials.`,
    );
    return EXIT.credentials;
  }
  if (outcome === 'bad_request') {
    deps.stdout(
      `Result:     the cache rejected the request as invalid (${detail}). Check the workspace ID.`,
    );
    return EXIT.config;
  }
  if (outcome === 'disabled') {
    deps.stdout(`Result:     the cache is turned off by its operator (${detail})`);
    return EXIT.server;
  }
  if (!outcome && status === 404) {
    deps.stdout(
      `Result:     no nx-s3-serverless-cache at this URL (${detail}). Check the url option.`,
    );
    return EXIT.config;
  }
  deps.stdout(`Result:     server problem (${detail})`);
  return EXIT.server;
}
