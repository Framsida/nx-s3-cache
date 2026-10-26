// CLI entry point (05 §4). The shebang is added by the build.
import { defaultCliDeps, runCli } from './cli-main.js';

declare const __PACKAGE_VERSION__: string;

void runCli(process.argv.slice(2), defaultCliDeps(__PACKAGE_VERSION__)).then((code) => {
  process.exitCode = code;
});
