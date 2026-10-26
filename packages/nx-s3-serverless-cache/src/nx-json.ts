// Finds this plugin's options in the nearest nx.json (05, CLI-1). nx.json may
// contain comments and trailing commas, as Nx itself accepts them.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PLUGIN_NAME = 'nx-s3-serverless-cache';

/** Removes comments and trailing commas outside strings. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export type ReadFile = (path: string) => string | undefined;

export const readFileIfExists: ReadFile = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

export interface NxJsonLookup {
  /** The nearest nx.json, if any. */
  path?: string;
  options: Record<string, unknown>;
  error?: string;
}

export function findPluginOptions(
  cwd: string,
  readFile: ReadFile = readFileIfExists,
): NxJsonLookup {
  let dir = cwd;
  for (;;) {
    const path = join(dir, 'nx.json');
    const text = readFile(path);
    if (text !== undefined) {
      let nxJson: { plugins?: unknown };
      try {
        nxJson = JSON.parse(stripJsonc(text)) as { plugins?: unknown };
      } catch (err) {
        return { path, options: {}, error: `${path} is not valid JSON: ${(err as Error).message}` };
      }
      const plugins = Array.isArray(nxJson.plugins) ? (nxJson.plugins as unknown[]) : [];
      const entry = plugins.find(
        (p) =>
          p === PLUGIN_NAME ||
          (typeof p === 'object' &&
            p !== null &&
            (p as { plugin?: unknown }).plugin === PLUGIN_NAME),
      );
      const options =
        typeof entry === 'object'
          ? ((entry as { options?: Record<string, unknown> }).options ?? {})
          : {};
      return { path, options };
    }
    const parent = dirname(dir);
    if (parent === dir) return { options: {} };
    dir = parent;
  }
}
