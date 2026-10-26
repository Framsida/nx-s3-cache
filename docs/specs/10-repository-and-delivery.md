# 10 — Repository layout and delivery

| | |
|---|---|
| Status | Draft |
| Decisions | D-5, D-6, D-23 (pnpm + Nx + Vitest), D-30 (no Terraform runs from this repo), D-31 (build from source), D-32 (package name) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Layout

```
apps/
  cache-handler/              # Lambda handler (03), bundled with esbuild
packages/
  token-format/               # Shared constants and types: token prefix, audience
                              # header, allowed query parameters (02 §3)
  nx-s3-serverless-cache/     # Published package: Nx plugin + CLI (05)
tools/
  spike-stub-server/          # SPIKE-1 stub server (08 §1)
e2e/
  fixtures/nx-21.0.0/         # Fixture workspaces (08 §5)
  fixtures/nx-latest/
  suites/
terraform/                    # The Terraform module (06)
examples/
  basic/                      # Example root module (06 §5), never applied here
docs/specs/                   # These specifications
```

- **REPO-1** An Nx workspace using pnpm. The pnpm version is pinned in the
  `packageManager` field.
- **REPO-2** TypeScript in strict mode everywhere. ESLint and Prettier.
- **REPO-3** Vitest for unit, contract and integration tests.
- **REPO-4** `token-format` holds only constants and types. Token creation lives
  in `nx-s3-serverless-cache` and validation in `cache-handler`, so the server
  bundle carries no client code.
- **REPO-5** The development Node.js version is 24, pinned with `.nvmrc` or
  `engines`. The Lambda runtime is `nodejs24.x`. The published client package
  supports Node.js 20 or newer (05, PKG-3) and MUST load as a plugin in Nx
  21.0.0 and the latest Nx (checked by E2E-1).
- **REPO-6** The repository README is the deployer guide: what the cache is,
  prerequisites (an existing public hosted zone, an S3 state bucket, Node.js
  and pnpm to build), and the procedures in 09.

## 2. Nx targets

| Project | Targets |
|---|---|
| `cache-handler` | `lint`, `typecheck`, `test`, `build` (esbuild bundle), `package` (zip) |
| `token-format` | `lint`, `typecheck`, `test`, `build` |
| `nx-s3-serverless-cache` | `lint`, `typecheck`, `test`, `build` |
| `e2e` | `e2e` (needs an existing deployment and AWS credentials; see 08, E2E-2) |
| `terraform` | `fmt-check`, `validate`, `tflint`, `tf-test` (all offline, 06 section 6) |

## 3. Lambda package (built from source, D-31)

- **PKGL-1** `pnpm nx run cache-handler:package` writes
  `dist/apps/cache-handler/lambda.zip`, containing one bundled `index.mjs` and
  its source map.
- **PKGL-2** The zip is reproducible: fixed file order and timestamps. The same
  tag gives the same `source_code_hash`, so `terraform plan` shows no change to
  the function unless the code changed.
- **PKGL-3** The AWS SDK v3 clients are bundled at a pinned version, not taken
  from the runtime, so behaviour does not change with runtime updates.
- **PKGL-4** The release version is compiled into the bundle and logged at cold
  start (03, FN-1).
- **PKGL-5** Building needs only Node.js, pnpm and the lockfile. No AWS access.

## 4. Delivery

- **DEL-1** Nothing in this repository applies Terraform, holds state or holds
  AWS credentials (D-30).
- **DEL-2** CI runs on every pull request: `lint`, `typecheck`, `test`, `build`,
  `package`, and the offline Terraform checks (06 section 6). It needs no AWS
  credentials. Platform assumed to be GitHub Actions (Q-18).
- **DEL-3** A release is a semver git tag `vX.Y.Z` on the default branch. One tag
  versions everything: handler, Terraform module and npm package. Deployers build
  from the tag (09, section 1).
- **DEL-4** Publishing `nx-s3-serverless-cache` to a registry is decided later
  (Q-17). Until then, workspaces can install it from a packed tarball
  (`pnpm pack`).
- **DEL-5** A breaking change to the token format (02, section 3) needs a new
  prefix (`nxcache-v2.`), and the handler accepts both during the migration.
