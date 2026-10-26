import { describe, expect, it } from 'vitest';
import { HASH_PATTERN, REGION_PATTERN, WORKSPACE_PATTERN } from './index.js';

describe('WORKSPACE_PATTERN', () => {
  it.each(['a', 'web-platform', '0', 'a'.repeat(63), 'a-1'])('accepts %s', (id) => {
    expect(WORKSPACE_PATTERN.test(id)).toBe(true);
  });

  it.each(['', '-a', 'a-', 'A', 'a_b', 'a.b', '..', 'a/b', 'a'.repeat(64), 'a%2Fb'])(
    'rejects %s',
    (id) => {
      expect(WORKSPACE_PATTERN.test(id)).toBe(false);
    },
  );
});

describe('HASH_PATTERN', () => {
  // Real values recorded by SPIKE-1 on Nx 21.0.0 and 24.0.1.
  it.each(['8485680016397879100', '18245694509759097932', '146863263245050714', 'abcDEF0123'])(
    'accepts %s',
    (hash) => {
      expect(HASH_PATTERN.test(hash)).toBe(true);
    },
  );

  it.each(['', '..', '1/2', '1.2', '%2F', '1 2', '1\n', 'é', 'a'.repeat(129)])(
    'rejects %j',
    (hash) => {
      expect(HASH_PATTERN.test(hash)).toBe(false);
    },
  );
});

describe('REGION_PATTERN', () => {
  it.each(['eu-west-1', 'us-east-1', 'ap-southeast-5', 'us-gov-west-1'])('accepts %s', (r) => {
    expect(REGION_PATTERN.test(r)).toBe(true);
  });

  it.each(['', 'eu-west', 'EU-WEST-1', 'eu-west-1.evil', 'eu_west_1', 'eu-west-1 '])(
    'rejects %j',
    (r) => {
      expect(REGION_PATTERN.test(r)).toBe(false);
    },
  );
});
