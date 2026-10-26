# 10 — Repository layout and delivery

| | |
|---|---|
| Status | Draft |
| Decisions | D-5, D-6, D-23 (pnpm + Nx + Vitest), D-24 (manual apply) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Layout

```
apps/
  cache-handler/          # Lambda handler (03), bundled with esbuild
packages/
  token-format/           # Shared constants and types: token prefix, audience
                          # header, allowed query parameters (02 §3)
  nx-iam-cache/           # Published package: Nx plugin + nx-cache-token CLI (05)
tools/
  spike-stub-server/      # SPIKE-1 stub server (08 §1)
e2e/
  fixtures/nx-21.0.0/     # Fixture workspaces (08 §5)
  fixtures/nx-latest/
  suites/
infra/                    # Terraform (06)
docs/specs/               # These specifications
```

- **REPO-1** An Nx workspace using pnpm. The pnpm version is pinned in the
  `packageManager` field.
- **REPO-2** TypeScript in strict mode everywhere. ESLint and Prettier.
- **REPO-3** Vitest for unit, contract and integration tests.
- **REPO-4** `token-format` holds only constants and types. Token creation lives
  in `nx-iam-cache` and validation in `cache-handler`, so the server bundle
  carries no client code.
- **REPO-5** The development Node.js version is 24, pinned with `.nvmrc` or
  `engines`. The Lambda runtime is `nodejs24.x`. The published client package
  supports Node.js 20 or newer (05, PKG-3) and MUST load as a plugin in Nx
  21.0.0 and the latest Nx (checked by E2E-1).

## 2. Nx targets

| Project | Targets |
|---|---|
| `cache-handler` | `lint`, `typecheck`, `test`, `build` (esbuild bundle), `package` (zip) |
| `token-format` | `lint`, `typecheck`, `test`, `build` |
| `nx-iam-cache` | `lint`, `typecheck`, `test`, `build`, `publish` |
| `e2e` | `e2e` (needs dev deployed and AWS credentials) |
| `infra` | `fmt-check`, `validate`, `tflint`, `tf-test` |

## 3. Lambda package

- **PKGL-1** `nx run cache-handler:package` writes
  `dist/apps/cache-handler/lambda.zip`, containing one bundled `index.mjs` and
  its source map.
- **PKGL-2** The zip is reproducible: fixed file order and timestamps. The same
  commit gives the same `source_code_hash`, so `terraform plan` shows no change
  to the function unless the code changed.
- **PKGL-3** The AWS SDK v3 clients are bundled at a pinned version, not taken
  from the runtime, so behaviour does not change with runtime updates.

## 4. Delivery

- **DEL-1** Terraform applies are manual (D-24), as in 09 section 1.
- **DEL-2** CI (platform open, Q-18) runs on every pull request: `lint`,
  `typecheck`, `test`, `build`, `package`, and the infra checks in 06 TF-10 and
  TF-11. These need no AWS credentials.
- **DEL-3** Whether CI also runs `terraform plan` (which needs a read-only AWS
  role) is open (Q-18).
- **DEL-4** Publishing the client package: registry and process open (Q-17).
  Versions follow semver. A breaking change to the token format (02, section 3)
  needs a new prefix (`nxcache-v2.`), and the server accepts both during the
  migration.
