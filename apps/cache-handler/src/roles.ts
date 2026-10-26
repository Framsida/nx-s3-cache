// Identity normalization and the allowed-role list (02 §5).

/** A role from ALLOWED_ROLES: `<account>:<role name>`, as Terraform derives it from each ARN. */
const ROLE_KEY_PATTERN = /^(\d{12}):([\w+=,.@-]{1,64})$/;

const ASSUMED_ROLE_ARN =
  /^arn:aws:sts::(\d{12}):assumed-role\/([\w+=,.@-]{1,64})\/([\w+=,.@-]{1,64})$/;
const IAM_USER_ARN = /^arn:aws:iam::(\d{12}):user\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]{1,64})$/;
const ROOT_ARN = /^arn:aws:iam::(\d{12}):root$/;
const FEDERATED_USER_ARN = /^arn:aws:sts::(\d{12}):federated-user\/([\w+=,.@-]{2,32})$/;

export type Identity =
  | {
      kind: 'role';
      /** For logs and object metadata, e.g. `role:123456789012:ci-runner` (02, 5.1). */
      principal: string;
      session: string;
      /** Key compared with the allowed list: account exact, role name lowercased (02, AUTHZ-2). */
      key: string;
    }
  | {
      /** IAM users, the root user and federated users are never allowed (02, 5.1). */
      kind: 'other';
      principal: string;
    };

/** Parses and validates ALLOWED_ROLES (02, AUTHZ-1, AUTHZ-2, AUTHZ-5). */
export function parseAllowedRoles(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      'ALLOWED_ROLES must be a non-empty JSON array of "<account>:<role name>" strings',
    );
  }
  const keys = new Set<string>();
  for (const entry of value) {
    const match = typeof entry === 'string' ? ROLE_KEY_PATTERN.exec(entry) : null;
    if (!match)
      throw new Error(
        `ALLOWED_ROLES entry is not "<account>:<role name>": ${JSON.stringify(entry)}`,
      );
    const key = `${match[1]}:${match[2]!.toLowerCase()}`;
    if (keys.has(key)) throw new Error(`ALLOWED_ROLES lists ${entry} more than once`);
    keys.add(key);
  }
  return keys;
}

/** Normalizes the `Arn` returned by STS `GetCallerIdentity` (02, table 5.1). */
export function normalizeIdentity(arn: string): Identity {
  const role = ASSUMED_ROLE_ARN.exec(arn);
  if (role) {
    const account = role[1]!;
    const name = role[2]!;
    const session = role[3]!;
    return {
      kind: 'role',
      principal: `role:${account}:${name}`,
      session: session.slice(0, 64),
      key: `${account}:${name.toLowerCase()}`,
    };
  }
  const user = IAM_USER_ARN.exec(arn);
  if (user) return { kind: 'other', principal: `user:${user[1]}:${user[2]}` };
  const root = ROOT_ARN.exec(arn);
  if (root) return { kind: 'other', principal: `root:${root[1]}` };
  const federated = FEDERATED_USER_ARN.exec(arn);
  if (federated)
    return { kind: 'other', principal: `federated-user:${federated[1]}:${federated[2]}` };
  return { kind: 'other', principal: 'unrecognized' };
}

export type Permission = 'read' | 'write';

/**
 * Every listed role may read and write (D-9, D-27). The two permissions stay
 * separate so they can be split later without a redesign (02, AUTHZ-4).
 */
export function isAllowed(
  identity: Identity,
  allowedRoles: ReadonlySet<string>,
  _permission: Permission,
): boolean {
  return identity.kind === 'role' && allowedRoles.has(identity.key);
}
