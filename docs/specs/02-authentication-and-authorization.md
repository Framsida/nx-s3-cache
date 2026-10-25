# 02 — Authentication and authorization

| | |
|---|---|
| Status | Draft |
| Depends on | [01 — Nx remote cache HTTP contract](./01-nx-remote-cache-contract.md) |
| Decisions | D-8 (signed STS token), D-9 (every allowed principal may read and write), D-11 (named roles only) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Problem

Nx sends only `Authorization: Bearer <token>`, with the token read from
`NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` (01, section 2). It cannot sign
requests with AWS SigV4. Callers (CI running in AWS, and developer machines) do
hold AWS credentials. We need a bearer token that proves an IAM identity, without
storing a shared secret anywhere.

## 2. Approach: presigned `sts:GetCallerIdentity` token

This is the same technique EKS uses (`aws-iam-authenticator`) and HashiCorp Vault
uses (AWS auth method).

1. The client uses its AWS credentials to **presign** an STS
   `GetCallerIdentity` request. Presigning needs no network call and no IAM
   permission, because every principal may call `GetCallerIdentity`.
2. The client encodes the presigned URL as the bearer token.
3. The server sends that presigned request to STS. STS checks the signature and,
   if it is valid, returns the caller's account, ARN and user ID.
4. The server maps the returned identity to a permission.

The server never sees the caller's secret key. The Lambda execution role needs no
STS permission, because the request is already signed by the caller.

## 3. Token format

```
nxcache-v1.<base64url(presigned URL), no padding>
```

The presigned URL has the form:

```
https://sts.<region>.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15
  &X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=...
  &X-Amz-Date=<yyyyMMddTHHmmssZ>
  &X-Amz-Expires=<seconds>
  &X-Amz-SignedHeaders=host;x-nx-cache-audience
  &X-Amz-Security-Token=...        (present for temporary credentials)
  &X-Amz-Signature=...
```

- **TOK-1 Audience binding.** The signature MUST cover the header
  `x-nx-cache-audience: <audience>`, where `<audience>` is a fixed value per
  cache deployment (for example `nx-cache:prod`). The server sends the same
  header to STS, so STS rejects the token if it was signed for another audience.
  This stops tokens made for other systems that use the same technique (EKS,
  Vault) from working here, and stops our tokens working against another cache
  deployment.
- **TOK-2 Regional endpoint.** The client MUST sign for the regional STS endpoint
  of the region the server is configured with. The global endpoint is not used.
- **TOK-3 Lifetime.** The client sets `X-Amz-Expires`. STS also rejects the
  request once the temporary credentials behind it expire, so the effective
  lifetime is the lower of the two. Default and maximum lifetime: open question
  AQ-2.
- **TOK-4 Size.** Tokens are typically 2–4 KB because of the session token. The
  server MUST reject tokens over 8 KB.

## 4. Server-side validation

The authorizer runs these steps in order. Any failure stops processing. Steps 1–5
run without a network call.

| Step | Check | On failure |
|---|---|---|
| 1 | `Authorization` header present, scheme `Bearer`, token starts with `nxcache-v1.`, ≤ 8 KB, valid base64url | 401 |
| 2 | Decoded value parses as a URL: scheme `https`, no user info, no explicit port, path `/`, host **exactly equal** to `sts.<configured region>.amazonaws.com` | 401 |
| 3 | Query has only the parameters listed in section 3, none repeated, with `Action=GetCallerIdentity`, `Version=2011-06-15`, `X-Amz-Algorithm=AWS4-HMAC-SHA256` | 401 |
| 4 | `X-Amz-SignedHeaders` includes `host` and `x-nx-cache-audience` | 401 |
| 5 | `X-Amz-Date` is no more than 5 minutes in the future; `X-Amz-Expires` ≤ configured maximum; now ≤ `X-Amz-Date` + `X-Amz-Expires` | 401 |
| 6 | `GET` the URL with headers `x-nx-cache-audience: <audience>` and `Accept: application/json`. Timeout 3 s. Redirects MUST NOT be followed. | STS 4xx → 401. STS 5xx, timeout or network error → 503. |
| 7 | Parse `GetCallerIdentityResponse.GetCallerIdentityResult` → `Account`, `Arn`, `UserId` | 503 |
| 8 | Normalize and authorize the identity (section 5) | 403 |

- **VAL-1** Step 2 is the guard against server-side request forgery. The server
  MUST NOT send the token's URL anywhere other than the configured STS host.
- **VAL-2** The token MUST NOT be logged in full. Logs MAY include the first 8
  hex characters of its SHA-256 hash, to correlate requests.
- **VAL-3 Caching.** A successful result MAY be cached, keyed by the SHA-256 of
  the token, for at most 5 minutes and never past the token's expiry. Failed
  results MUST NOT be cached. Where the cache lives depends on the front-door
  choice (open question Q-5).
- **VAL-4 Fail closed.** If STS is unreachable, the request fails (503). It is
  never allowed through. Nx then continues without the remote cache (to be
  confirmed by CQ-5).

## 5. Identity normalization and authorization

### 5.1 Normalization

| STS `Arn` form | Normalized principal | Allowed? |
|---|---|---|
| `arn:aws:sts::<acct>:assumed-role/<RoleName>/<SessionName>` | `role:<acct>:<RoleName>` (session name kept for audit) | Yes, if it matches a rule |
| `arn:aws:iam::<acct>:user/<path/><UserName>` | — | **Never** (D-11: roles only) |
| `arn:aws:iam::<acct>:root` | — | **Never** |
| `arn:aws:sts::<acct>:federated-user/<Name>` | — | **Never** (unless decided otherwise) |

The assumed-role ARN carries no IAM path, so rules match on account ID and role
name.

### 5.2 Rules

Authorization is a list of rules supplied as Terraform input and passed to the
Lambda as configuration:

```
rules = [
  {
    account           = "<12-digit id>",
    role_name_pattern = "<exact name or prefix*>",
    workspaces        = ["<workspace id>", ...] | ["*"],
    permissions       = ["read", "write"]
  },
  ...
]
```

- **AUTHZ-1** Under D-11, only named roles are allowed: an explicit account ID
  plus a role-name pattern. A principal that matches no rule gets 403.
  "Authenticated" means "matches a rule", not "holds any valid AWS credential".
  Without rules, anyone with an AWS account anywhere could use the cache.
- **AUTHZ-2** If several rules match, the union of their workspaces and
  permissions is granted.
- **AUTHZ-3** `GET` requires `read` on the requested workspace. `PUT` requires
  `write` on it. A `"*"` workspace entry matches every workspace in the
  configured set (03, WS-2).
- **AUTHZ-4** Under decision D-9, every rule grants `["read", "write"]` for now.
  The model still keeps read and write separate, so they can be split later
  (for example, developers read-only) without a redesign.
- **AUTHZ-5** Patterns are exact strings or globs that support only a trailing
  `*` (for example `AWSReservedSSO_Developer_*` for IAM Identity Center
  permission sets). No regular expressions.

## 6. Accepted risk R-1: cache poisoning (CREEP, CVE-2025-36852)

Decision D-9 lets every allowed principal write. A principal running untrusted
code (a PR branch, a compromised laptop) can upload an artifact under a hash that
a later trusted build will restore. Nx's own S3 cache was deprecated for this
reason. The product owner accepted this risk for now. These mitigations are
required:

- **R1-M1 Allow-list.** Only principals matching a rule can write (AUTHZ-1).
- **R1-M2 Immutable records.** An existing hash is never overwritten (01,
  CON-3). An attacker can only take a hash nobody has stored yet.
- **R1-M3 Writer audit.** Every stored object records the normalized writer
  principal and session name (as S3 object metadata, for example
  `x-amz-meta-writer`), plus upload time. Every request logs the principal.
- **R1-M4 Purge by writer.** It MUST be possible to find and delete every object
  written by a given principal or session (operational runbook, tooling to be
  specified).
- **R1-M5 Revisit trigger.** If the cache is ever used by builds that ship to
  production, this decision MUST be revisited.

## 7. Open questions

| ID | Question |
|---|---|
| AQ-1 | The actual rule values: account IDs, role names or patterns, and their workspaces. (The form is decided: D-11, named roles.) |
| AQ-2 | Default and maximum token lifetime (depends on Q-10: longest Nx command). |
| AQ-3 | ~~Are IAM users allowed?~~ Answered: no, roles only (D-11). |
| AQ-4 | Audience value and STS region per environment. |
