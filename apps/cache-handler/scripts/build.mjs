// Bundles the handler into one ESM file with its source map (10, PKGL-1).
// The AWS SDK is bundled at the lockfile's version, not taken from the Lambda
// runtime (PKGL-3), and the release version is compiled in (PKGL-4).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

function releaseVersion() {
  if (process.env.RELEASE_VERSION) return process.env.RELEASE_VERSION;
  try {
    return execFileSync('git', ['describe', '--tags', '--always'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '0.0.0-unknown';
  }
}

const version = releaseVersion();

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: '../../dist/apps/cache-handler/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  keepNames: true,
  sourcemap: true,
  legalComments: 'none',
  define: { __RELEASE_VERSION__: JSON.stringify(version) },
  // Some bundled CommonJS dependencies call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

console.log(`Built cache-handler ${version}`);
