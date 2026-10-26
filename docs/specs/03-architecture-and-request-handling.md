# 03 — Architecture and request handling

| | |
|---|---|
| Status | Draft |
| Depends on | [01](./01-nx-remote-cache-contract.md), [02](./02-authentication-and-authorization.md), [04](./04-storage.md) |
| Decisions | D-10, D-12, D-13, D-15, D-16, D-27 |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Overview

```
 Developer laptop / CI in AWS
 ┌──────────────────────────────────────────┐
 │ nx run-many ...                          │
 │  └─ preTasksExecution (our Nx plugin)    │
 │       AWS SDK credentials → presign STS  │
 │       → sets NX_SELF_HOSTED_REMOTE_*     │
 │  └─ Nx HTTP remote cache (Rust)          │
 └───────────────┬──────────────────────────┘
                 │ HTTPS  GET|PUT /<workspace>/v1/cache/<hash>
                 │ Authorization: Bearer nxcache-v1.…
                 ▼
 Route 53  <domain_name>  (alias, in an existing hosted zone)
                 ▼
 API Gateway REST API (Regional, custom domain, TLS 1.2+)
                 │ Lambda proxy integration
                 ▼
 Lambda  nx-cache-handler (TypeScript, Node.js, arm64)
   ├── HTTPS GET presigned URL ──▶ STS (regional)   validate identity
   └── GetObject / PutObject  ───▶ S3 bucket          read / write artifact
```

| Component | Responsibility |
|---|---|
| Nx plugin + CLI (05) | Mint the bearer token from local AWS credentials. Set the Nx environment variables. |
| API Gateway REST API | TLS, custom domain, routing, throttling, access logs, plain-text gateway errors. No authentication of its own. |
| Lambda `nx-cache-handler` | Validate the request, authenticate (02), authorize, read and write S3. |
| S3 bucket (04) | Artifact storage, retention, encryption. |
| STS | Verifies the caller's signature and returns the caller's identity. |

All of this is created by the Terraform module (06), which deployers apply from
their own repositories.

## 2. URL layout and workspaces

- **URL-1** Cache URLs have the form
  `https://<domain>/<workspace>/v1/cache/<hash>`. Consumers set
  `NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://<domain>/<workspace>`. The plugin
  does this for them (05).
- **URL-2** This depends on Nx keeping the path prefix of the server URL (01,
  CQ-3). If SPIKE-1 shows that Nx drops it, use the fallback: the URL becomes
  `https://<domain>/v1/cache/<hash>` and the workspace moves into the token,
  `nxcache-v1.<workspace>.<base64url URL>`. The chosen option is recorded here
  when SPIKE-1 completes.
- **WS-1** A workspace ID matches `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.
- **WS-2** Workspace IDs are not registered anywhere. Any ID that matches WS-1
  is accepted, so adding a workspace needs no Terraform change (D-27).
- **WS-3** Each workspace has its own S3 key prefix (04) and its own metric
  dimension (07). There is no access isolation between workspaces: every
  allowed role can read and write all of them (D-27). Separate prefixes keep
  artifacts apart and allow per-workspace purges.

## 3. API Gateway (REST API)

- **APIGW-1** Endpoint type `REGIONAL`. The default `execute-api` endpoint MUST
  be disabled, so the custom domain is the only way in.
- **APIGW-2** Custom domain with an ACM certificate in the same region, security
  policy TLS 1.2 or newer, and a Route 53 alias record in the existing hosted
  zone (06).
- **APIGW-3** Exactly one resource path, `/{workspace}/v1/cache/{hash}`, with
  `GET` and `PUT` methods. Both use a Lambda proxy integration with
  authorization type `NONE`. Authentication happens in the handler so that
  errors are plain text (01, CON-6). No API keys.
- **APIGW-4** `binaryMediaTypes = ["*/*"]`, so request bodies reach Lambda as
  base64 and base64 responses go back to the client as raw bytes. SPIKE-2 MUST
  confirm byte-for-byte round trips and that `text/plain` errors arrive
  unchanged.
- **APIGW-5** Gateway responses MUST use `Content-Type: text/plain` with a short
  message:

  | Gateway response | Status | Message (indicative) |
  |---|---|---|
  | `MISSING_AUTHENTICATION_TOKEN` (unknown route) | 404 | `Not found` |
  | `REQUEST_TOO_LARGE` | 413 | `Task output is too large for the Nx cache` |
  | `THROTTLED` | 429 | `Nx cache is rate limiting requests; retry later` |
  | `INTEGRATION_TIMEOUT` | 504 | `Nx cache timed out` |
  | `DEFAULT_5XX` | (unchanged) | `Nx cache is unavailable` |
  | `DEFAULT_4XX` | (unchanged) | `Request rejected by the Nx cache` |

- **APIGW-6** Stage-level throttling, with rate and burst as Terraform inputs.
- **APIGW-7** Access logs in JSON to CloudWatch Logs: request ID, source IP,
  method, resource path, status, response length, integration latency, user
  agent.
- **APIGW-8** Execution logging with full request and response data MUST be
  off. It would write bearer tokens to the logs.
- **APIGW-9** No WAF web ACL (D-19). Abuse is contained by stage throttling
  (APIGW-6), optional Lambda reserved concurrency (FN-3) and rejecting malformed
  tokens before any STS call (02, steps 1–5). If a WAF is added later, its rules
  MUST NOT block binary bodies up to the artifact size limit. For example, the
  AWS managed rule `SizeRestrictions_BODY` blocks bodies over 8 KB.

## 4. Lambda function

- **FN-1** One function, `nx-cache-handler`, written in TypeScript and bundled
  to a single file. Runtime `nodejs24.x`, architecture `arm64`. It logs its
  release version once at cold start.
- **FN-2** Memory 1024 MB and timeout 20 s by default (below the 29 s API Gateway
  integration timeout). Both are Terraform inputs.
- **FN-3** Reserved concurrency is an optional Terraform input. Setting it caps
  cost and the blast radius of abuse.
- **FN-4** The function is **not** attached to a VPC. It only calls public AWS
  endpoints (STS, S3), so this avoids NAT cost.
- **FN-5** Configuration via environment variables:

  | Variable | Meaning |
  |---|---|
  | `BUCKET_NAME` | Artifact bucket |
  | `STS_REGION` | Deployment region; tokens must target its STS endpoint (02, TOK-2) |
  | `TOKEN_AUDIENCE` | Audience value (02, TOK-1) |
  | `TOKEN_MAX_LIFETIME_SECONDS` | Upper bound on `X-Amz-Expires` (02, step 5) |
  | `MAX_ARTIFACT_BYTES` | Upload size limit (section 6) |
  | `ALLOWED_ROLES` | JSON array of `<account>:<role name>` pairs, derived from `allowed_role_arns` (02, AUTHZ-2) |

  Terraform MUST fail the plan if all variables together exceed the 4 KB
  Lambda limit (roughly 60–100 roles fit). The list moves to SSM Parameter
  Store if that ever becomes a limit.
- **FN-6** Execution role permissions, and nothing more:
  - `s3:GetObject` and `s3:PutObject` on `arn:aws:s3:::<bucket>/v1/*`.
  - `s3:ListBucket` on the bucket, limited to the `v1/` prefix. Without it, S3
    answers `403` instead of `404` for missing keys, and misses would look like
    errors.
  - CloudWatch Logs write for the function's own log group.
  - No `s3:DeleteObject`, no STS permissions (02, section 2).
- **FN-7** Configuration is parsed and validated once, at cold start. Invalid
  configuration MUST fail the cold start with a clear log line, not individual
  requests.

## 5. Request handling

### 5.1 Processing order

Cheap checks that need no network call run first. Nothing about the existence
of a record is revealed before authorization succeeds.

| # | Step | Failure |
|---|---|---|
| 1 | Method is `GET` or `PUT`; path matches section 2 | 404 |
| 2 | `workspace` matches WS-1; `hash` matches the hash pattern (01, CON-2) | 400 |
| 3 | `PUT` only: `Content-Length` present, integer, ≤ `MAX_ARTIFACT_BYTES` | missing → 411, too large → 413 |
| 4 | Authenticate (02, section 4) | 401 / 503 |
| 5 | Authorize: the caller's role is in `ALLOWED_ROLES` and has the method's permission (02, AUTHZ-4) | 403 |
| 6 | `GET`: storage read (5.2). `PUT`: storage write (5.3) | see below |

### 5.2 `GET`

1. `GetObject` on `v1/<workspace>/<hash>`.
2. `NoSuchKey` → `404`, no body.
3. Found → `200`, `Content-Type: application/octet-stream`, body base64-encoded
   with `isBase64Encoded: true`.
4. Any other S3 error → `503` `text/plain`, logged with the S3 request ID.

### 5.3 `PUT`

1. Decode the base64 body. If the decoded length differs from `Content-Length`,
   return `400` and store nothing (01, CON-4).
2. `PutObject` to `v1/<workspace>/<hash>` with:
   - `IfNoneMatch: "*"`, so an existing object is never replaced (01, CON-3);
   - `ChecksumAlgorithm: SHA256`, so S3 verifies the bytes it received;
   - `ContentType: application/octet-stream`;
   - writer metadata (04, section 4).
3. S3 `412 PreconditionFailed` (object exists) → `409`.
4. S3 `409 ConditionalRequestConflict` (concurrent write of the same key) → `409`.
   The other writer's object stands.
5. Success → `200`, no body.
6. Any other S3 error → `503` `text/plain`, logged with the S3 request ID.

### 5.4 Status codes and messages

Every non-2xx response, except `404` and `409` (which have no body, per 01), MUST
carry `Content-Type: text/plain` and a message the CLI user can act on, without
internal detail (01, CON-7).

| Status | When | Example message |
|---|---|---|
| 400 | Bad workspace or hash syntax; body length mismatch | `Invalid cache request` |
| 401 | Missing, malformed, expired or rejected token | `Nx cache: AWS credentials missing or expired. Run "aws sso login" and retry.` |
| 403 | Role not on the allowed list | `Nx cache: your AWS role is not allowed to use this cache.` |
| 404 | Cache miss or unknown route | (no body) |
| 409 | Record already exists | (no body) |
| 411 | `PUT` without `Content-Length` | `Content-Length is required` |
| 413 | Upload larger than `MAX_ARTIFACT_BYTES` | `Nx cache: task output is 7.2 MB; the limit is 4.0 MB. It was not cached remotely.` |
| 503 | STS or S3 unavailable | `Nx cache is temporarily unavailable` |

## 6. Size limit (D-10, D-12)

- **SIZE-1** `MAX_ARTIFACT_BYTES` defaults to 4 MiB (4,194,304 bytes) and is a
  Terraform input. Terraform MUST reject values above 4,500,000. Base64 adds a
  third, and the Lambda event (about 6 MB maximum) also holds headers and the
  token.
- **SIZE-2** Uploads whose `Content-Length` is over the limit, but small enough to
  reach the Lambda, get `413` from step 3, before authentication. The handler
  emits a `RejectedOversize` metric with the declared size (07, MET-1).
- **SIZE-3** Uploads too large for the Lambda event never reach the handler. The
  gateway response (APIGW-5) supplies the message. SPIKE-2 MUST record the exact
  status code and body that Nx shows in that case. A metric filter on the access
  logs counts these.
- **SIZE-4** Stored objects are never larger than the limit, so `GET` responses
  always fit in a Lambda response.

## 7. Spikes referenced here

- **SPIKE-1** (client behaviour, against a stub server): answers 01 CQ-1 to CQ-7,
  and confirms PC-5 (token set by `preTasksExecution` reaches the Rust client).
- **SPIKE-2** (a test deployment): binary round trips through the REST API
  (APIGW-4), gateway error bodies (APIGW-5), and oversize behaviour (SIZE-3).
