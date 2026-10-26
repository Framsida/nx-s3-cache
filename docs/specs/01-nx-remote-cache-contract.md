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
native binary. They are not part of the upstream contract. SPIKE-1 confirmed
them on `nx@21.0.0` and `nx@24.0.1` (section 5).

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
  prefix. The pattern is `^[A-Za-z0-9]{1,128}$` (D-37): Nx sends 1 to 20
  decimal digits, and letters keep custom task hashers working.
- **CON-3** Records are immutable. A `PUT` for a hash that already exists MUST
  return `409` and MUST NOT change the stored object, including under concurrent
  uploads of the same hash.
- **CON-4** A `PUT` without `Content-Length` MUST be rejected. A body whose
  length differs from `Content-Length` MUST NOT be stored.
- **CON-5** A `GET` for a missing hash MUST return `404` with no body.
- **CON-6** ~~A missing, malformed or expired token MUST return `401`. A valid
  identity without the needed permission MUST return `403`.~~ Amended by D-34,
  because Nx fails the whole command on a `401`, and on a `403` for `GET`
  (section 5, CQ-1 and CQ-5). A missing, malformed or expired token, and a valid
  identity without the needed permission, get a miss on `GET` (`404`) and a
  skipped upload on `PUT` (`403` with a short `text/plain` message that tells
  the user what to do). The `x-nx-cache-outcome` response header says which
  (`unauthenticated`, `forbidden`).
- **CON-7** Error messages MUST NOT reveal internal details such as bucket names,
  account IDs, role ARNs or stack traces.
- **CON-8** The server MUST NOT read, change or re-encode artifact bytes.
- **CON-9** A successful `GET` MUST return `Content-Type: application/octet-stream`
  and the exact bytes that were stored.

## 5. Answers from SPIKE-1

SPIKE-1 ran a stub server against real workspaces on `nx@21.0.0` and
`nx@24.0.1`, with the daemon and plugin isolation on and off. The tool and raw
results are in [`tools/spike-stub-server`](../../tools/spike-stub-server/README.md).
Both versions behaved the same for these questions.

- **CQ-1** A `401` is shown as `Unauthorized: <body>` and **fails the Nx
  command**, on `GET` and on `PUT`.
- **CQ-2** `307` and `308` are followed for `GET` and `PUT`. The `PUT` body is
  re-sent. `Authorization` is kept on a same-origin redirect and dropped on a
  cross-origin one. CB-4 is confirmed; D-10 stands for now.
- **CQ-3** The path prefix is kept: `https://cache.example.com/workspace-a`
  gives `/workspace-a/v1/cache/{hash}`. A trailing slash gives `//v1`, so the
  plugin strips it. URL-1 is used (D-38).
- **CQ-4** The token is read once per command: a value changed in the process
  during a run was not used by later requests. CB-3 is confirmed.
- **CQ-5** Only `200` and `404` on `GET`, and `200`, `403` and `409` on `PUT`,
  let the command succeed. A `403` on `PUT` is silent; its body is not shown.
  Every other status (including `400`, `403` on `GET`, `404` on `PUT`, `411`,
  `413`, `429` and `5xx`), a `200` whose body is not a tarball, and a refused
  connection fail the command with `Misconfigured remote cache endpoint:
  Unexpected response status: …` or `Failed to send request`. This led to D-34,
  D-35 and D-36.
- **CQ-6** Hashes are decimal strings of 1 to 20 digits (u64), for example
  `8485680016397879100` and `18245694509759097932`. `PUT` bodies are gzip
  (`1f8b08…`). `GET` requests carry `Content-Type: application/octet-stream` and
  no body.
- **CQ-7** No client timeout was found: an answer after 35 s was accepted, and an
  unanswered request was still waiting after 280 s.
