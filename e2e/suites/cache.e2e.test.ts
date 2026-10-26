// E2E-1: real Nx workspaces, on Nx 21.0.0 and the latest Nx, with the plugin
// installed from a packed tarball, against an existing deployment (E2E-2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  config,
  FixtureWorkspace,
  get,
  NO_CREDENTIALS,
  profileEnv,
  put,
  randomHash,
  tokenFor,
  workspaceId,
} from './support.js';

const REMOTE_HIT = '[remote cache]';

describe.skipIf(!config)('E2E-1', () => {
  for (const nxVersion of config?.nxVersions ?? []) {
    describe(`Nx ${nxVersion}`, () => {
      let ws: FixtureWorkspace;
      const allowed = () => profileEnv(config!.allowedProfile);
      const unlisted = () => profileEnv(config!.unlistedProfile);

      beforeAll(() => {
        ws = FixtureWorkspace.create(nxVersion, workspaceId(nxVersion.replace(/\W/g, '')));
      });
      afterAll(() => ws?.dispose());

      it('1-2: an allowed role stores outputs, and a clean checkout gets a remote hit', () => {
        ws.touch();
        const first = ws.nx('build', allowed());
        expect(first.status, first.output).toBe(0);
        expect(first.output).not.toContain('Nx remote cache disabled');

        ws.resetLocalCache();
        const second = ws.nx('build', allowed());
        expect(second.status, second.output).toBe(0);
        expect(second.output).toContain(REMOTE_HIT);
      });

      it('3: a role not on the allowed list is refused, and the build still passes', () => {
        ws.touch();
        const run = ws.nx('build', unlisted());
        expect(run.status, run.output).toBe(0);

        ws.resetLocalCache();
        // Nothing was stored for that hash, so an allowed role misses too.
        const again = ws.nx('build', allowed());
        expect(again.output).not.toContain(REMOTE_HIT);

        const check = ws.cli(['check'], unlisted());
        expect(check.status, check.output).toBe(1);
        expect(check.output).toContain("not on the cache's allowed list");
        expect(ws.cli(['check'], allowed()).status).toBe(0);
      });

      it('4: one role reads and writes two workspaces, kept apart', async () => {
        const token = await tokenFor(config!.allowedProfile);
        const a = workspaceId(`${nxVersion.replace(/\W/g, '')}-a`);
        const b = workspaceId(`${nxVersion.replace(/\W/g, '')}-b`);
        const hash = randomHash();
        const body = Buffer.from(`artifact for ${a}`);

        expect((await put(a, hash, body, token)).status).toBe(200);
        const hit = await get(a, hash, token);
        expect(hit.status).toBe(200);
        expect(Buffer.from(await hit.arrayBuffer())).toEqual(body);
        const other = await get(b, hash, token);
        expect(other.status).toBe(404);
        expect(other.headers.get('x-nx-cache-outcome')).toBe('miss');
      });

      it('5: an output over the size limit is not cached, and the build still passes', () => {
        ws.touch();
        const run = ws.nx('big', allowed());
        expect(run.status, run.output).toBe(0);
        ws.resetLocalCache();
        const again = ws.nx('big', allowed());
        expect(again.status, again.output).toBe(0);
        expect(again.output).not.toContain(REMOTE_HIT);
      });

      it('6: without AWS credentials the plugin warns and the build uses the local cache', () => {
        ws.touch();
        const run = ws.nx('build', NO_CREDENTIALS);
        expect(run.status, run.output).toBe(0);
        expect(run.output).toContain('Nx remote cache disabled: no AWS credentials found');
      });
    });
  }
});
