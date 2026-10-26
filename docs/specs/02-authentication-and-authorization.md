# 02 — Authentication and authorization

| | |
|---|---|
| Status | Draft |
| Depends on | [01 — Nx remote cache HTTP contract](./01-nx-remote-cache-contract.md) |
| Decisions | D-8 (signed STS token), D-9 (every allowed principal may read and write), D-27 (one list of exact role ARNs) |

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
4. The server checks the returned identity against the allowed roles.

The server never sees the caller's secret key. The Lambda execution role needs no
STS permission, because the request is already signed by the caller. Callers can
be in any AWS account; no cross-account trust is needed.

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
  `x-nx-cache-audience: <audience>`. `<audience>` is fixed per deployment and
  defaults to the cache's domain name, for example `nx-cache.example.com`
  (06). The server sends the same header to STS, so STS rejects the token if it
  was signed for another audience. This stops tokens made for other systems that
  use the same technique (EKS, Vault) from working here, and stops our tokens
  working against another deployment of this cache.
- **TOK-2 Regional endpoint.** The client MUST sign for the regional STS endpoint
  of the region the cache is deployed in. The global endpoint is not used.
- **TOK-3 Lifetime.** The client sets `X-Amz-Expires`. STS also rejects the
  request once the temporary credentials behind it expire, so the effective
  lifetime is the lower of the two. Default and maximum lifetime are both
  3600 s (05, section 5).
- **TOK-4 Size.** Tokens are typically 2–4 KB because of the session token. The
  server MUST reject tokens over 8 KB.

## 4. Server-side validation

The handler runs these steps in order. Any failure stops processing. Steps 1–5
run without a network call.

| Step | Check | On failure |
|---|---|---|
| 1 | `Authorization` header present, scheme `Bearer`, token starts with `nxcache-v1.`, ≤ 8 KB, valid base64url | 401 |
| 2 | Decoded value parses as a URL: scheme `https`, no user info, no explicit port, path `/`, host **exactly equal** to `sts.<deployment region>.amazonaws.com` | 401 |
| 3 | Query has only the parameters listed in section 3, none repeated, with `Action=GetCallerIdentity`, `Version=2011-06-15`, `X-Amz-Algorithm=AWS4-HMAC-SHA256` | 401 |
| 4 | `X-Amz-SignedHeaders` includes `host` and `x-nx-cache-audience` | 401 |
| 5 | `X-Amz-Date` is no more than 5 minutes in the future; `X-Amz-Expires` ≤ configured maximum; now ≤ `X-Amz-Date` + `X-Amz-Expires` | 401 |
| 6 | `GET` the URL with headers `x-nx-cache-audience: <audience>` and `Accept: application/json`. Timeout 3 s. Redirects MUST NOT be followed. | STS 4xx → 401. STS 5xx, timeout or network error → 503. |
| 7 | Parse `GetCallerIdentityResponse.GetCallerIdentityResult` → `Account`, `Arn`, `UserId` | 503 |
| 8 | Normalize the identity and check it against the allowed roles (section 5) | 403 |

The statuses above classify the failure. What Nx receives follows D-34: a miss
on `GET` and a skipped upload on `PUT`, with the outcome `unauthenticated`
(401), `upstream_error` (503) or `forbidden` (403) in the `x-nx-cache-outcome`
header (03, 5.4). STS throttling arrives as a `400` with the code `Throttling`;
it says nothing about the token, so it counts as a 503.

- **VAL-1** Step 2 is the guard against server-side request forgery. The server
  MUST NOT send the token's URL anywhere other than the deployment region's STS
  host.
- **VAL-2** The token MUST NOT be logged in full. Logs MAY include the first 8
  hex characters of its SHA-256 hash, to correlate requests.
- **VAL-3 Caching.** A successful result MAY be cached in the Lambda's memory,
  keyed by the SHA-256 of the token, for at most 5 minutes and never past the
  token's expiry. Failed results MUST NOT be cached.
- **VAL-4 Fail closed.** If STS is unreachable, the request fails (503). It is
  never allowed through. Nx then continues without the remote cache, because
  the answer is a miss or a skipped upload (D-34; 01, CQ-5).

## 5. Identity normalization and authorization

### 5.1 Normalization

| STS `Arn` form | Normalized principal | Allowed? |
|---|---|---|
| `arn:aws:sts::<acct>:assumed-role/<RoleName>/<SessionName>` | `role:<acct>:<RoleName>` (session name kept for audit) | Yes, if the role is on the allowed list |
| `arn:aws:iam::<acct>:user/<path/><UserName>` | — | **Never** (roles only) |
| `arn:aws:iam::<acct>:root` | — | **Never** |
| `arn:aws:sts::<acct>:federated-user/<Name>` | — | **Never** |

### 5.2 Allowed roles

- **AUTHZ-1** The deployer supplies `allowed_role_arns`: a list of exact IAM role
  ARNs, which may come from any AWS account (D-27). A caller whose role is not on
  the list gets 403. "Authenticated" means "is using a listed role", not "holds
  any valid AWS credential". Without the list, anyone with an AWS account
  anywhere could use the cache.
- **AUTHZ-2 Matching.** The STS result gives the account ID and role name, but not
  the role's IAM path. Each configured ARN is therefore reduced to
  `<account>:<role name>`, where the name is the last segment of the ARN's
  resource part. For example,
  `arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Dev_0123abcd`
  becomes `111111111111:AWSReservedSSO_Dev_0123abcd`. Role names are unique
  within an account whatever their path, so this match is exact. The account ID
  is compared exactly. The role name is compared case-insensitively, as IAM
  treats role names.
- **AUTHZ-3 No wildcards.** IAM Identity Center roles are listed with their full
  generated name. If a permission set is re-provisioned and its role name
  changes, the list must be updated (09).
- **AUTHZ-4 Permissions.** Every listed role may read and write every workspace
  (D-9, D-27). The handler still checks `read` for `GET` and `write` for `PUT`
  as separate permissions internally, so they can be split later (for example,
  developers read-only) without a redesign.
- **AUTHZ-5 Validation.** Only the `aws` partition is supported. Each ARN MUST
  match `^arn:aws:iam::\d{12}:role/(?:[\w+=,.@-]+/)*[\w+=,.@-]{1,64}$`. Duplicates
  after normalization are rejected by Terraform validation (06).

## 6. Accepted risk R-1: cache poisoning (CREEP, CVE-2025-36852)

Decisions D-9 and D-27 let every listed role write to every workspace. A role
running untrusted code (a PR branch, a compromised laptop) can upload an artifact
under a hash that a later trusted build will restore, in any workspace. Nx's own
S3 cache was deprecated for this reason. The product owner accepted this risk for
now. These mitigations are required:

- **R1-M1 Allow-list.** Only listed roles can write (AUTHZ-1).
- **R1-M2 Immutable records.** An existing hash is never overwritten (01,
  CON-3). An attacker can only take a hash nobody has stored yet.
- **R1-M3 Writer audit.** Every stored object records the normalized writer
  principal and session name (04, section 4), plus upload time. Every request
  logs the principal.
- **R1-M4 Purge by writer.** It MUST be possible to find and delete every object
  written by a given principal or session (04, AUD-3; 09, OPS-1).
- **R1-M5 Revisit trigger.** If the cache is ever used by builds that ship to
  production, this decision MUST be revisited.

## 7. Questions

| ID | Question | Status |
|---|---|---|
| AQ-1 | Which accounts and roles are allowed? | Answered: a deployer-supplied list of exact role ARNs (D-27) |
| AQ-2 | Default and maximum token lifetime? | Answered: 3600 s for both (D-21, 05 section 5) |
| AQ-3 | Are IAM users allowed? | Answered: no, roles only |
| AQ-4 | Audience value and STS region? | Answered: audience defaults to the domain name; STS region is the deployment region (06) |
