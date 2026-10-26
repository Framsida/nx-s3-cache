# 03 — Architecture and request handling

| | |
|---|---|
| Status | Draft |
| Depends on | [01](./01-nx-remote-cache-contract.md), [02](./02-authentication-and-authorization.md), [04](./04-storage.md) |
| Decisions | D-10, D-12, D-13, D-15, D-16, D-27, D-34, D-35, D-36, D-38 |

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
                 │ PUT only: size gate (the same Lambda as an authorizer, D-36)
                 │ Lambda proxy integration
                 ▼
 Lambda  nx-cache-handler (TypeScript, Node.js, arm64)
   ├── HTTPS GET presigned URL ──▶ STS (regional)   validate identity
   └── GetObject / PutObject  ───▶ S3 bucket          read / write artifact
```

| Component | Responsibility |
|---|---|
| Nx plugin + CLI (05) | Mint the bearer token from local AWS credentials. Set the Nx environment variables. |
| API Gateway REST API | TLS, custom domain, routing, throttling, access logs, plain-text gateway errors, the `PUT` size gate. No authentication of its own. |
| Lambda `nx-cache-handler` | Validate the request, authenticate (02), authorize, read and write S3. Also the `PUT` size gate (APIGW-10). |
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
  `nxcache-v1.<workspace>.<base64url URL>`. SPIKE-1 showed that Nx keeps the
  path prefix, so URL-1 is used (D-38).
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
  `GET` and `PUT` methods. Both use a Lambda proxy integration. `GET` has
  authorization type `NONE`; `PUT` has the size gate (APIGW-10). Authentication
  happens in the handler, so its answers can follow D-34. No API keys. The
  routes, the integration, the size gate and the gateway responses are all in
  the API's OpenAPI body, so a re-import cannot drop any of them.
- **APIGW-4** `binaryMediaTypes = ["*/*"]`, so request bodies reach Lambda as
  base64 and base64 responses go back to the client as raw bytes. SPIKE-2 MUST
  confirm byte-for-byte round trips and that `text/plain` errors arrive
  unchanged.
- **APIGW-5** Gateway responses MUST use `Content-Type: text/plain` with a short
  message. Responses that only `PUT` can trigger are `403`, a skipped upload
  (D-34, D-36). The others can happen on `GET` too, where only `200` and `404`
  are safe, so no status avoids failing the Nx command (PC-9):

  | Gateway response | Status | Message |
  |---|---|---|
  | `MISSING_AUTHENTICATION_TOKEN` (unknown route) | 404 | `Not found` |
  | `REQUEST_TOO_LARGE` (body over 10 MB; `PUT` only) | 403 | `Nx cache: task output is too large for the Nx cache. It was not cached remotely.` |
  | `ACCESS_DENIED` (size gate denied; `PUT` only) | 403 | same |
  | `UNAUTHORIZED` (no `Content-Length` for the size gate; `PUT` only) | 403 | `Content-Length is required` |
  | `AUTHORIZER_FAILURE`, `AUTHORIZER_CONFIGURATION_ERROR` (`PUT` only) | 403 | `Nx cache is temporarily unavailable` |
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
- **APIGW-10 Size gate (D-36).** `PUT` has a `REQUEST` authorizer backed by the
  handler function, with caching off and `Content-Length` as its identity
  source. It allows a declared size up to `MAX_ARTIFACT_BYTES` and denies
  anything larger, before API Gateway forwards the body. Without it, a body too
  large for the Lambda event never reaches the handler and API Gateway answers
  with a `5xx`, which fails the Nx command. The gate logs each denial as an
  `oversize` request (07, LOG-1). A missing or malformed length is allowed
  through, and the handler answers it (section 5.1, step 3).

## 4. Lambda function

- **FN-1** One function, `nx-cache-handler`, written in TypeScript and bundled
  to a single file. Runtime `nodejs24.x`, architecture `arm64`. It logs its
  release version once at cold start. The same function is the `PUT` size gate
  (APIGW-10); it tells authorizer events from proxy events by their shape.
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
  | `ENVIRONMENT` | Instance name, the `Environment` metric dimension (07, MET-1) |
  | `CACHE_ENABLED` | `false` turns the cache off gracefully (D-35) |
  | `NODE_OPTIONS` | `--enable-source-maps`, for readable stack traces |

  Terraform MUST fail the plan if all variables together exceed the 4 KB
  Lambda limit (roughly 60–100 roles fit). The list moves to SSM Parameter
  Store if that ever becomes a limit.
- **FN-6** Execution role permissions, and nothing more:
  - `s3:GetObject` and `s3:PutObject` on `arn:aws:s3:::<bucket>/v1/*`.
  - `s3:ListBucket` on the bucket. Without it, S3 answers `403` instead of
    `404` for missing keys, and misses would look like errors. It is not
    narrowed to the `v1/` prefix: whether S3's implicit check for a missing key
    honours an `s3:prefix` condition is undocumented, and if it did not, every
    miss would count as an S3 failure. The handler never lists keys.
  - CloudWatch Logs write for the function's own log group.
  - No `s3:DeleteObject`, no STS permissions (02, section 2).
- **FN-7** Configuration is parsed and validated once, at cold start. Invalid
  configuration MUST fail the cold start with a clear log line, not individual
  requests.

## 5. Request handling

### 5.1 Processing order

Cheap checks that need no network call run first. Nothing about the existence
of a record is revealed before authorization succeeds.

Following D-34, a failure is never answered with the status the step names.
Instead it becomes a miss on `GET` (`404`, no body) or a skipped upload on `PUT`
(`403`, `text/plain` reason). The `x-nx-cache-outcome` header carries the
outcome (07, LOG-1). The "Outcome" column gives it.

| # | Step | Outcome on failure |
|---|---|---|
| 1 | Method is `GET` or `PUT`; path matches section 2 | `bad_request` (`404` for both methods) |
| 2 | `workspace` matches WS-1; `hash` matches the hash pattern (01, CON-2) | `bad_request` |
| 3 | `PUT` only: `Content-Length` present, integer, ≤ `MAX_ARTIFACT_BYTES` | missing or malformed → `bad_request`, too large → `oversize` |
| 4 | Authenticate (02, section 4) | `unauthenticated` / `upstream_error` |
| 5 | Authorize: the caller's role is in `ALLOWED_ROLES` and has the method's permission (02, AUTHZ-4) | `forbidden` |
| 6 | `GET`: storage read (5.2). `PUT`: storage write (5.3) | see below |

Before step 2, `CACHE_ENABLED=false` answers every valid request with the
outcome `disabled` (D-35). An unexpected error anywhere is caught and answered
the same way, with the outcome `internal_error`.

### 5.2 `GET`

1. `GetObject` on `v1/<workspace>/<hash>`.
2. `NoSuchKey` → `404`, no body.
3. Found → `200`, `Content-Type: application/octet-stream`, body base64-encoded
   with `isBase64Encoded: true`.
4. Any other S3 error → `404` (outcome `upstream_error`, D-34), logged with the
   S3 request ID.

### 5.3 `PUT`

1. Decode the base64 body. If the decoded length differs from `Content-Length`,
   return `403` (outcome `bad_request`) and store nothing (01, CON-4).
2. `PutObject` to `v1/<workspace>/<hash>` with:
   - `IfNoneMatch: "*"`, so an existing object is never replaced (01, CON-3);
   - `ChecksumAlgorithm: SHA256`, so S3 verifies the bytes it received;
   - `ContentType: application/octet-stream`;
   - writer metadata (04, section 4).
3. S3 `412 PreconditionFailed` (object exists) → `409`.
4. S3 `409 ConditionalRequestConflict` (concurrent write of the same key) → `409`.
   The other writer's object stands.
5. Success → `200`, no body.
6. Any other S3 error → `403` `text/plain` (outcome `upstream_error`, D-34),
   logged with the S3 request ID.

### 5.4 Status codes and messages

Nx fails the command on any status but `200` and `404` for `GET`, and `200`,
`403` and `409` for `PUT` (PC-9). Those are the only statuses the handler uses
(D-34). Every `403` carries `Content-Type: text/plain` and a message the user can
act on, without internal detail (01, CON-7). Nx does not show it today, but the
CLI's `check` and anyone using `curl` see it. `404` and `409` have no body, per
01.

| Outcome | `GET` | `PUT` | `PUT` message |
|---|---|---|---|
| `hit` / `stored` | 200 | 200 | (no body) |
| `miss` | 404 | — | |
| `exists` | — | 409 | (no body) |
| `bad_request` (route, syntax, length mismatch) | 404 | 403 | `Invalid cache request` |
| `bad_request` (no `Content-Length`) | — | 403 | `Content-Length is required` |
| `oversize` | — | 403 | `Nx cache: task output is 7.2 MB; the limit is 4.0 MB. It was not cached remotely.` |
| `unauthenticated` | 404 | 403 | `Nx cache: AWS credentials missing or expired. Run "aws sso login" and retry.` |
| `forbidden` | 404 | 403 | `Nx cache: your AWS role is not allowed to use this cache.` |
| `upstream_error`, `internal_error` | 404 | 403 | `Nx cache is temporarily unavailable` |
| `disabled` | 404 | 403 | `Nx cache is disabled by its operator` |

Requests that never reach the handler keep API Gateway's statuses (APIGW-5).
Those not limited to `PUT` (throttling, a crashed or timed-out Lambda, an
outage) fail the Nx command, and there is nothing the server can do about it.

## 6. Size limit (D-10, D-12)

- **SIZE-1** `MAX_ARTIFACT_BYTES` defaults to 4 MiB (4,194,304 bytes) and is a
  Terraform input. Terraform MUST reject values above 4,500,000. Base64 adds a
  third, and the Lambda event (about 6 MB maximum) also holds headers and the
  token.
- **SIZE-2** Uploads whose `Content-Length` is over the limit are denied by the
  size gate (APIGW-10) before the body is forwarded, and get a `403`. A request
  that reaches the handler anyway (for example, invoked directly) gets the same
  answer from step 3, before authentication. Both emit a `RejectedOversize`
  metric with the declared size (07, MET-1).
- **SIZE-3** Bodies over API Gateway's 10 MB limit never reach the gate; the
  `REQUEST_TOO_LARGE` gateway response answers them with a `403` (APIGW-5). A
  metric filter on the access logs counts these. SPIKE-2 MUST confirm both
  paths on a deployment.
- **SIZE-4** Stored objects are never larger than the limit, so `GET` responses
  always fit in a Lambda response.

## 7. Spikes referenced here

- **SPIKE-1** (client behaviour, against a stub server): done. Answers in 01 §5
  and 05 §6; it confirmed PC-5 and led to D-34 to D-38.
- **SPIKE-2** (a test deployment): binary round trips through the REST API
  (APIGW-4), gateway error bodies (APIGW-5), the size gate (APIGW-10) and
  oversize behaviour (SIZE-3). Automated in the end-to-end suite (08).
