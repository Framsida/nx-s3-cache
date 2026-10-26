// UT-2: identity normalization (02, table 5.1) and allowed-role matching
// (02, AUTHZ-2). Reducing configured ARNs (with and without IAM paths) to
// `<account>:<role name>` happens in Terraform and is tested there
// (terraform/tests/validation.tftest.hcl).
import { describe, expect, it } from 'vitest';
import { isAllowed, normalizeIdentity, parseAllowedRoles } from './roles.js';

describe('normalizeIdentity', () => {
  it('normalizes an assumed role and keeps the session name', () => {
    expect(normalizeIdentity('arn:aws:sts::111111111111:assumed-role/ci-runner/i-0abc123')).toEqual(
      {
        kind: 'role',
        principal: 'role:111111111111:ci-runner',
        session: 'i-0abc123',
        key: '111111111111:ci-runner',
      },
    );
  });

  it('normalizes an IAM Identity Center role with an email session name', () => {
    const identity = normalizeIdentity(
      'arn:aws:sts::222222222222:assumed-role/AWSReservedSSO_Dev_0123abcd/jane.doe@example.com',
    );
    expect(identity).toMatchObject({
      kind: 'role',
      principal: 'role:222222222222:AWSReservedSSO_Dev_0123abcd',
      session: 'jane.doe@example.com',
      key: '222222222222:awsreservedsso_dev_0123abcd',
    });
  });

  it.each([
    ['an IAM user', 'arn:aws:iam::111111111111:user/alice', 'user:111111111111:alice'],
    [
      'an IAM user with a path',
      'arn:aws:iam::111111111111:user/team/alice',
      'user:111111111111:alice',
    ],
    ['the root user', 'arn:aws:iam::111111111111:root', 'root:111111111111'],
    [
      'a federated user',
      'arn:aws:sts::111111111111:federated-user/bob',
      'federated-user:111111111111:bob',
    ],
    ['another partition', 'arn:aws-cn:sts::111111111111:assumed-role/ci-runner/s', 'unrecognized'],
    ['a role ARN instead of a session', 'arn:aws:iam::111111111111:role/ci-runner', 'unrecognized'],
    ['garbage', 'not-an-arn', 'unrecognized'],
  ])('never allows %s', (_name, arn, principal) => {
    expect(normalizeIdentity(arn)).toEqual({ kind: 'other', principal });
  });
});

describe('parseAllowedRoles', () => {
  it('lowercases role names and keeps accounts exact', () => {
    expect([...parseAllowedRoles(['111111111111:CI-Runner', '222222222222:dev'])]).toEqual([
      '111111111111:ci-runner',
      '222222222222:dev',
    ]);
  });

  it.each([
    ['an empty list', []],
    ['not a list', '111111111111:ci-runner'],
    ['an ARN instead of a pair', ['arn:aws:iam::111111111111:role/ci-runner']],
    ['an 11-digit account', ['11111111111:ci-runner']],
    ['a wildcard', ['111111111111:ci-*']],
    ['a path in the name', ['111111111111:team/ci-runner']],
    ['a name over 64 characters', [`111111111111:${'a'.repeat(65)}`]],
    ['a number', [111111111111]],
    ['duplicates differing only in case', ['111111111111:ci-runner', '111111111111:CI-RUNNER']],
  ])('rejects %s', (_name, value) => {
    expect(() => parseAllowedRoles(value)).toThrow();
  });
});

describe('isAllowed', () => {
  const allowed = parseAllowedRoles([
    '111111111111:ci-runner',
    '222222222222:AWSReservedSSO_Dev_0123abcd',
  ]);
  const role = (arn: string) => normalizeIdentity(arn);

  it('allows a listed role for read and write', () => {
    const identity = role('arn:aws:sts::111111111111:assumed-role/ci-runner/build-1');
    expect(isAllowed(identity, allowed, 'read')).toBe(true);
    expect(isAllowed(identity, allowed, 'write')).toBe(true);
  });

  it('matches role names case-insensitively', () => {
    expect(
      isAllowed(role('arn:aws:sts::111111111111:assumed-role/CI-Runner/s'), allowed, 'read'),
    ).toBe(true);
    expect(
      isAllowed(
        role('arn:aws:sts::222222222222:assumed-role/awsreservedsso_dev_0123abcd/s'),
        allowed,
        'read',
      ),
    ).toBe(true);
  });

  it('does not allow the same role name in another account', () => {
    expect(
      isAllowed(role('arn:aws:sts::333333333333:assumed-role/ci-runner/s'), allowed, 'write'),
    ).toBe(false);
  });

  it('does not allow an unlisted role', () => {
    expect(
      isAllowed(role('arn:aws:sts::111111111111:assumed-role/deployer/s'), allowed, 'read'),
    ).toBe(false);
  });

  it('never allows users, even with a listed name', () => {
    expect(isAllowed(role('arn:aws:iam::111111111111:user/ci-runner'), allowed, 'read')).toBe(
      false,
    );
  });
});
