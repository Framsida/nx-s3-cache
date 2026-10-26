# 01 — Nx remote cache HTTP contract

| | |
|---|---|
| Status | Draft |
| Upstream source | [Nx docs: Self-hosted remote cache](https://nx.dev/docs/guides/tasks--caching/self-hosted-caching) (page last updated 2026-10-20) |
| Machine-readable copy | [`nx-remote-cache.openapi.json`](./nx-remote-cache.openapi.json) (verbatim from the Nx docs) |
| Client inspected | `nx@24.0.1` (npm), native binary `@nx/nx-linux-x64-gnu@24.0.1` |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Upstream contract (fixed by Nx, not negotiable)

Nx publishes an OpenAPI 3.0 document that any self-hosted cache server must
implement. It has one resource with two operations.

### 1.1 `PUT /v1/cache/{hash}` — upload a task output

| Item | Value |
|---|---|
| Auth | `Authorization: Bearer <token>` |
| Path param | `hash` (string, required): the task hash for this output |
| Header | `Content-Length` (number, required): size in bytes |
| Body | `application/octet-stream`, binary |

| Status | Meaning | Body |
|---|---|---|
| 200 | Uploaded | none |
| 401 | Missing or invalid token | `text/plain`: message shown to the Nx CLI user |
| 403 | Forbidden, e.g. a read-only token used to write | `text/plain`: message shown to the Nx CLI user |
| 409 | Cannot override an existing record | none |

### 1.2 `GET /v1/cache/{hash}` — download a task output

| Item | Value |
|---|---|
| Auth | `Authorization: Bearer <token>` |
| Path param | `hash` (string, required) |

| Status | Meaning | Body |
|---|---|---|
| 200 | Found | `application/octet-stream`: the artifact bytes |
| 403 | Forbidden | `text/plain`: message shown to the Nx CLI user |
| 404 | Not found (cache miss) | none |

The upstream spec does not list 401 for `GET`. See open question CQ-1.

### 1.3 Payload

The body is a tar archive. Nx states that "the underlying data format may change
in future Nx versions" while the API stays stable. The server therefore treats
the body as **opaque bytes**.

## 2. Client configuration (fixed by Nx)

| Variable | Purpose |
|---|---|
| `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` | Base URL of the cache server. Setting it enables the HTTP remote cache. |
| `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` | Value sent as the bearer token. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `0` disables TLS verification. Our deployment MUST NOT require this. |

## 3. Observed client behaviour (informative, from `nx@24.0.1`)

These points come from reading the published `nx` package and the strings in its
native binary. They are not part of the upstream contract and **MUST be confirmed
by the client spike (SPIKE-1)** before design decisions rely on them.

- **CB-1 Rust HTTP client.** The HTTP cache is implemented in Rust
  (`packages/nx/src/native/cache/http_remote_cache.rs`) using `reqwest` 0.12 with
  `rustls`. It supports HTTPS proxies. It is not available in the WASM build of Nx.
- **CB-2 Precedence.** Nx picks one remote cache in this order: Nx Cloud (if
  configured in `nx.json`), then `@nx/s3-cache`, `@nx/shared-fs-cache`,
  `@nx/gcs-cache`, `@nx/azure-cache` (and their `@nx/powerpack-*` aliases), and
  only then the HTTP cache. Consumer workspaces MUST have none of the others
  configured or installed, or our server is silently ignored.
- **CB-3 One client per command.** The remote cache object is created once per
  Nx command and reused. The token is therefore probably read once, so a token
  must stay valid for the longest single Nx invocation.
- **CB-4 In-memory archive.** The upload archive appears to be built in memory
  before sending. With `reqwest`'s default redirect policy, a buffered body can
  be re-sent on a `307`/`308` redirect, and the `Authorization` header is
  dropped when the redirect goes to a different host. If confirmed, the server
  can redirect bodies straight to presigned S3 URLs instead of moving them
  through Lambda.
- **CB-5 Opaque format.** The binary bundles `tar` and `flate2`, which is
  consistent with a (possibly gzipped) tar archive. Confirms 1.3: do not parse.

## 4. Server requirements derived from the contract

- **CON-1** The server MUST implement `GET` and `PUT` on `/v1/cache/{hash}`
  exactly as in section 1, including status codes and `text/plain` error bodies.
- **CON-2** The server MUST validate `hash` against a strict allow-list pattern
  before using it in any storage key, so a crafted hash cannot escape its key
  prefix. (Exact pattern to be fixed once SPIKE-1 records real hash values.)
- **CON-3** Records are immutable. A `PUT` for a hash that already exists MUST
  return `409` and MUST NOT change the stored object, including under concurrent
  uploads of the same hash.
- **CON-4** A `PUT` without `Content-Length` MUST be rejected. A body whose
  length differs from `Content-Length` MUST NOT be stored.
- **CON-5** A `GET` for a missing hash MUST return `404` with no body.
- **CON-6** A missing, malformed or expired token MUST return `401`. A valid
  identity without the needed permission MUST return `403`. Both carry a short
  `text/plain` message that tells the CLI user what to do.
- **CON-7** Error messages MUST NOT reveal internal details such as bucket names,
  account IDs, role ARNs or stack traces.
- **CON-8** The server MUST NOT read, change or re-encode artifact bytes.
- **CON-9** A successful `GET` MUST return `Content-Type: application/octet-stream`
  and the exact bytes that were stored.

## 5. Open questions on the contract

These are answered by SPIKE-1 (a stub server plus a real Nx workspace), not by a
product decision.

- **CQ-1** How does the client react to `401` on `GET`? It contains an
  `Unauthorized:` message, so it probably handles it; confirm.
- **CQ-2** Does the client follow `307` redirects for `GET` and for `PUT`, re-send
  the `PUT` body, and drop `Authorization` on a cross-host redirect? (CB-4)
- **CQ-3** Does `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` keep a path prefix, for
  example `https://cache.example.com/workspace-a` → `/workspace-a/v1/cache/{hash}`?
- **CQ-4** Is the token read once per command or per request? (CB-3)
- **CQ-5** How does the client treat `409`, `403`, `5xx` and timeouts? Do they
  fail the Nx run or only print a warning?
- **CQ-6** What do real hashes look like (alphabet, length)? Feeds CON-2.
- **CQ-7** What are the client's connect and request timeouts? Affects how long
  Lambda can take.
