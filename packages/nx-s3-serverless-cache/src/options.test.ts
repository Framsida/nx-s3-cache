import { describe, expect, it } from 'vitest';
import { resolveOptions } from './options.js';

const base = {
  url: 'https://nx-cache.example.com',
  workspace: 'web-platform',
  region: 'eu-west-1',
};

describe('resolveOptions', () => {
  it('fills in the defaults', () => {
    expect(resolveOptions(base)).toEqual({
      ok: true,
      options: {
        url: 'https://nx-cache.example.com',
        workspace: 'web-platform',
        region: 'eu-west-1',
        audience: 'nx-cache.example.com',
        tokenLifetimeSeconds: 3600,
        serverUrl: 'https://nx-cache.example.com/web-platform',
      },
    });
  });

  it('keeps an explicit audience, profile and lifetime', () => {
    const result = resolveOptions({
      ...base,
      audience: 'cache-prod',
      profile: 'nx-cache',
      tokenLifetimeSeconds: 1800,
    });
    expect(result).toMatchObject({
      ok: true,
      options: { audience: 'cache-prod', profile: 'nx-cache', tokenLifetimeSeconds: 1800 },
    });
  });

  it('allows plain HTTP for loopback test servers only', () => {
    expect(resolveOptions({ ...base, url: 'http://127.0.0.1:4510' })).toMatchObject({
      ok: true,
      options: { serverUrl: 'http://127.0.0.1:4510/web-platform', audience: '127.0.0.1' },
    });
    expect(resolveOptions({ ...base, url: 'http://nx-cache.example.com' }).ok).toBe(false);
  });

  it.each([
    ['a missing url', { ...base, url: undefined }],
    ['a relative url', { ...base, url: 'nx-cache.example.com' }],
    ['a url with a path', { ...base, url: 'https://nx-cache.example.com/web-platform' }],
    ['a url with a query', { ...base, url: 'https://nx-cache.example.com/?a=1' }],
    ['a url with credentials', { ...base, url: 'https://user:pw@nx-cache.example.com' }],
    ['an uppercase workspace', { ...base, workspace: 'Web' }],
    ['a workspace with a slash', { ...base, workspace: 'a/b' }],
    ['a missing region', { ...base, region: undefined }],
    ['a region with a suffix', { ...base, region: 'eu-west-1.evil' }],
    ['an audience with spaces', { ...base, audience: 'a b' }],
    ['an empty profile', { ...base, profile: '' }],
    ['a fractional lifetime', { ...base, tokenLifetimeSeconds: 99.5 }],
    ['a lifetime as a string', { ...base, tokenLifetimeSeconds: '3600' }],
    ['a lifetime over 12 hours', { ...base, tokenLifetimeSeconds: 43_201 }],
    ['an array', [base]],
  ])('rejects %s', (_name, raw) => {
    expect(resolveOptions(raw).ok).toBe(false);
  });
});
