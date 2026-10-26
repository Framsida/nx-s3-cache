// SPIKE-1 stub server (08 §1). Throwaway: logs every request as one JSON line
// and answers with a scripted response. Run with `node src/server.ts` (Node.js
// 24 strips the types). Not part of any shipped package.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** What the stub does for one method. `store` behaves like a real cache. */
export interface Rule {
  mode: 'store' | 'status' | 'redirect' | 'hang';
  status?: number;
  body?: string;
  contentType?: string;
  /** For `redirect`: base URL the request is sent on to, path kept. */
  redirectTo?: string;
  delayMs?: number;
}

export interface Scenario {
  name: string;
  get: Rule;
  put: Rule;
}

const DEFAULT_SCENARIO: Scenario = {
  name: 'store',
  get: { mode: 'store' },
  put: { mode: 'store' },
};

const port = Number(process.env.PORT ?? 4510);
const logFile = process.env.LOG_FILE;
const label = process.env.LABEL ?? 'primary';

let scenario: Scenario = DEFAULT_SCENARIO;
const store = new Map<string, Buffer>();

function log(entry: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), server: label, ...entry });
  if (logFile) appendFileSync(logFile, line + '\n');
  else console.log(line);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  body?: string | Buffer,
  contentType?: string,
): void {
  const headers: Record<string, string> = {};
  if (body !== undefined && contentType) headers['content-type'] = contentType;
  res.writeHead(status, headers);
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const body = await readBody(req);

  if (url.pathname === '/__scenario' && req.method === 'POST') {
    scenario = { ...DEFAULT_SCENARIO, ...(JSON.parse(body.toString('utf8')) as Partial<Scenario>) };
    store.clear();
    log({ control: 'scenario', scenario });
    return send(res, 204);
  }
  if (url.pathname === '/__store' && req.method === 'GET') {
    return send(res, 200, JSON.stringify([...store.keys()]), 'application/json');
  }

  const auth = req.headers.authorization;
  log({
    method: req.method,
    path: url.pathname,
    query: url.search,
    host: req.headers.host,
    authorization: auth,
    contentLength: req.headers['content-length'],
    contentType: req.headers['content-type'],
    userAgent: req.headers['user-agent'],
    otherHeaders: Object.keys(req.headers).filter(
      (h) => !['host', 'authorization', 'content-length', 'content-type', 'user-agent'].includes(h),
    ),
    bodyBytes: body.length,
    bodySha256: body.length ? createHash('sha256').update(body).digest('hex') : undefined,
    bodyMagic: body.subarray(0, 4).toString('hex') || undefined,
  });

  const match = /^(?:\/.*)?\/v1\/cache\/([^/]+)$/.exec(url.pathname);
  // Requests that already followed a redirect are served from the store, so a
  // same-origin redirect does not loop.
  const redirected = url.pathname.startsWith('/__redirected/');
  const rule = redirected
    ? DEFAULT_SCENARIO.get
    : req.method === 'PUT'
      ? scenario.put
      : scenario.get;
  if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));

  switch (rule.mode) {
    case 'hang':
      return; // never answer; the client's timeout decides
    case 'status':
      return send(res, rule.status ?? 500, rule.body, rule.contentType ?? 'text/plain');
    case 'redirect': {
      res.writeHead(rule.status ?? 307, { location: `${rule.redirectTo}${url.pathname}` });
      return void res.end();
    }
    case 'store': {
      if (!match) return send(res, 404);
      const key = url.pathname.replace(/^\/__redirected/, '');
      if (req.method === 'GET') {
        const found = store.get(key);
        return found ? send(res, 200, found, 'application/octet-stream') : send(res, 404);
      }
      if (req.method === 'PUT') {
        if (store.has(key)) return send(res, 409);
        store.set(key, body);
        return send(res, 200);
      }
      return send(res, 405);
    }
  }
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    log({ error: String(err) });
    send(res, 500, 'stub error', 'text/plain');
  });
}).listen(port, '127.0.0.1', () => log({ control: 'listening', port }));
