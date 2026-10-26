// Bundles the plugin and the CLI as CommonJS for Node.js 20 and newer (05,
// PKG-3). token-format is inlined, because it is not published; the AWS SDK
// packages stay runtime dependencies (05, PKG-4).
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['@aws-sdk/*', '@smithy/*'],
  define: { __PACKAGE_VERSION__: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' });
await build({
  ...common,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  banner: { js: '#!/usr/bin/env node' },
});
