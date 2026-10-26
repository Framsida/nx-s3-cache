// Shared setup for the end-to-end suites (08 §5). They run against a deployment
// named by environment variables (E2E-2); nothing here creates one.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDefaultCredentials } from '../../packages/nx-s3-serverless-cache/src/credentials.js';
import {
  resolveOptions,
  type ResolvedOptions,
} from '../../packages/nx-s3-serverless-cache/src/options.js';
import { createToken } from '../../packages/nx-s3-serverless-cache/src/token.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

export interface E2eConfig {
  url: string;
  region: string;
  audience?: string;
  allowedProfile: string;
  unlistedProfile: string;
  maxArtifactBytes: number;
  nxVersions: string[];
  /** Unique per run, so workspaces and hashes never collide with earlier runs. */
  runId: string;
}

function readConfig(): E2eConfig | undefined {
  const env = process.env;
  if (!env.E2E_URL) return undefined;
  const missing = ['E2E_REGION', 'E2E_ALLOWED_PROFILE', 'E2E_UNLISTED_PROFILE'].filter(
    (k) => !env[k],
  );
  if (missing.length > 0)
    throw new Error(`E2E_URL is set, so these are required too: ${missing.join(', ')}`);
  return {
    url: env.E2E_URL.replace(/\/+$/, ''),
    region: env.E2E_REGION!,
    audience: env.E2E_AUDIENCE || undefined,
    allowedProfile: env.E2E_ALLOWED_PROFILE!,
    unlistedProfile: env.E2E_UNLISTED_PROFILE!,
    maxArtifactBytes: Number(env.E2E_MAX_ARTIFACT_BYTES ?? 4 * 1024 * 1024),
    nxVersions: (env.E2E_NX_VERSIONS ?? '21.0.0,latest').split(',').map((v) => v.trim()),
    runId: `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`,
  };
}

export const config = readConfig();

export function workspaceId(name: string): string {
  return `e2e-${config!.runId}-${name}`.slice(0, 63);
}

export function pluginOptions(workspace: string): ResolvedOptions {
  const result = resolveOptions({
    url: config!.url,
    region: config!.region,
    audience: config!.audience,
    workspace,
  });
  if (!result.ok) throw new Error(result.error);
  return result.options;
}

/** A bearer token for a profile, made the same way the plugin makes it. */
export async function tokenFor(profile: string): Promise<string> {
  const options = pluginOptions(workspaceId('token'));
  const credentials = await resolveDefaultCredentials(profile);
  const { token } = await createToken({
    credentials,
    region: options.region,
    audience: options.audience,
    lifetimeSeconds: 900,
    now: new Date(),
  });
  return token;
}

export function cacheUrl(workspace: string, hash: string): string {
  return `${config!.url}/${workspace}/v1/cache/${hash}`;
}

export function randomHash(): string {
  // Decimal, like Nx's own hashes (SPIKE-1, CQ-6), and never a real one.
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(19, '0')}`.slice(0, 20);
}

/**
 * fetch, retried once when a pooled keep-alive connection was closed under it.
 * That is a property of the test client's connection pool, not of the cache.
 */
export async function send(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const code = ((err as Error).cause as { code?: string } | undefined)?.code;
    if (code !== 'UND_ERR_SOCKET' && code !== 'ECONNRESET') throw err;
    return fetch(url, init);
  }
}

export function put(
  workspace: string,
  hash: string,
  body: Buffer,
  token?: string,
): Promise<Response> {
  return send(cacheUrl(workspace, hash), {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: {
      'content-type': 'application/octet-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

export function get(workspace: string, hash: string, token?: string): Promise<Response> {
  return send(cacheUrl(workspace, hash), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

// ---------------------------------------------------------------------------
// Fixture workspaces (E2E-1)

let tarball: string | undefined;

/** Packs the plugin once; the e2e target builds it first. */
function pluginTarball(): string {
  if (tarball) return tarball;
  const dir = mkdtempSync(join(tmpdir(), 'nx-cache-e2e-pack-'));
  const result = spawnSync('pnpm', ['pack', '--pack-destination', dir], {
    cwd: join(REPO, 'packages/nx-s3-serverless-cache'),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`pnpm pack failed: ${result.stderr}`);
  const file = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (!file) throw new Error('pnpm pack produced no tarball');
  tarball = join(dir, file);
  return tarball;
}

export interface NxRun {
  status: number | null;
  output: string;
}

export class FixtureWorkspace {
  readonly dir: string;

  private constructor(
    readonly nxVersion: string,
    readonly workspace: string,
  ) {
    this.dir = mkdtempSync(join(tmpdir(), `nx-cache-e2e-${nxVersion}-`));
  }

  static create(nxVersion: string, workspace: string): FixtureWorkspace {
    const ws = new FixtureWorkspace(nxVersion, workspace);
    const fixture = join(
      REPO,
      'e2e/fixtures',
      nxVersion === 'latest' ? 'nx-latest' : `nx-${nxVersion}`,
    );
    cpSync(fixture, ws.dir, { recursive: true });
    ws.writeNxJson(workspace);
    mkdirSync(join(ws.dir, 'libs/app'), { recursive: true });
    writeFileSync(
      join(ws.dir, 'libs/app/project.json'),
      JSON.stringify({
        name: 'app',
        root: 'libs/app',
        targets: {
          build: {
            executor: 'nx:run-commands',
            options: { command: `node -e "${writeOutput('dist/small.bin', 64 * 1024)}"` },
          },
          big: {
            executor: 'nx:run-commands',
            options: {
              command: `node -e "${writeOutput('dist-big/big.bin', config!.maxArtifactBytes + 512 * 1024)}"`,
            },
          },
        },
      }),
    );
    writeFileSync(
      join(ws.dir, '.gitignore'),
      'node_modules\nlibs/app/dist\nlibs/app/dist-big\n.nx\n',
    );
    ws.exec('git', ['init', '-q']);
    const install = ws.exec('npm', [
      'install',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      pluginTarball(),
    ]);
    if (install.status !== 0)
      throw new Error(`npm install failed in ${ws.dir}:\n${install.output}`);
    return ws;
  }

  writeNxJson(workspace: string): void {
    const options = pluginOptions(workspace);
    writeFileSync(
      join(this.dir, 'nx.json'),
      JSON.stringify({
        plugins: [
          {
            plugin: 'nx-s3-serverless-cache',
            options: {
              url: options.url,
              workspace,
              region: options.region,
              audience: options.audience,
            },
          },
        ],
        targetDefaults: {
          build: { cache: true, outputs: ['{projectRoot}/dist'] },
          big: { cache: true, outputs: ['{projectRoot}/dist-big'] },
        },
      }),
    );
  }

  /** New inputs, so the next run has a hash nobody has stored. */
  touch(): void {
    writeFileSync(join(this.dir, 'libs/app/input.txt'), randomUUID());
  }

  resetLocalCache(): void {
    rmSync(join(this.dir, '.nx'), { recursive: true, force: true });
    rmSync(join(this.dir, 'libs/app/dist'), { recursive: true, force: true });
    rmSync(join(this.dir, 'libs/app/dist-big'), { recursive: true, force: true });
  }

  nx(target: string, env: NodeJS.ProcessEnv): NxRun {
    return this.exec('npx', ['nx', 'run', `app:${target}`, '--output-style=static'], env);
  }

  cli(args: string[], env: NodeJS.ProcessEnv): NxRun {
    return this.exec('npx', ['nx-s3-serverless-cache', ...args], env);
  }

  exec(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): NxRun {
    const result = spawnSync(command, args, {
      cwd: this.dir,
      encoding: 'utf8',
      env: { ...baseEnv(), ...extraEnv },
      timeout: 600_000,
    });
    return {
      status: result.status,
      // Strip terminal colours so tests can match Nx's output.
      // eslint-disable-next-line no-control-regex
      output: `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, ''),
    };
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function writeOutput(path: string, bytes: number): string {
  return `const fs=require('fs');fs.mkdirSync('libs/app/${path.split('/')[0]}',{recursive:true});fs.writeFileSync('libs/app/${path}',require('crypto').randomBytes(${bytes}))`;
}

/** No inherited cache settings or credentials; the daemon off so plugin warnings reach the output. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
    NX_TUI: 'false',
    CI: 'true',
  };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('NX_SELF_HOSTED_') ||
      key.startsWith('E2E_') ||
      /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)$/.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

export function profileEnv(profile: string): NodeJS.ProcessEnv {
  return { AWS_PROFILE: profile };
}

/** Nothing the default credential chain could find. */
export const NO_CREDENTIALS: NodeJS.ProcessEnv = {
  AWS_CONFIG_FILE: join(tmpdir(), 'nx-cache-e2e-no-config'),
  AWS_SHARED_CREDENTIALS_FILE: join(tmpdir(), 'nx-cache-e2e-no-credentials'),
  AWS_EC2_METADATA_DISABLED: 'true',
};
