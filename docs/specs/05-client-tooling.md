# 05 — Client tooling: Nx plugin and token CLI

| | |
|---|---|
| Status | Draft |
| Depends on | [02](./02-authentication-and-authorization.md), [03](./03-architecture-and-request-handling.md) |
| Decisions | D-14 (plugin + CLI), D-21 (commands under 1 hour), D-22 (Nx 21 or newer), D-32 (package name) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Package

- **PKG-1** One npm package, **`nx-s3-serverless-cache`**, holds:
  - the Nx plugin entry point, exporting `preTasksExecution`;
  - a CLI binary with the same name, `nx-s3-serverless-cache`, so that
    `npx nx-s3-serverless-cache check` works without installing anything first;
  - a shared library that creates tokens, used by both.

  The registry it is published to is decided later (Q-17).
- **PKG-2** Supported Nx versions: 21.0.0 or newer (D-22). Both the HTTP remote
  cache and the `preTasksExecution` env propagation exist from 20.8.0, so 21.0.0
  is a safe floor.
- **PKG-3** Supported Node.js versions: those supported by the Nx versions in
  PKG-2 (Node.js 20 or newer). Set in `engines`.
- **PKG-4** Runtime dependencies are limited to the AWS SDK v3 credential
  providers and the SigV4 signer. No AWS service clients are needed.
- **PKG-5** The package version equals the release tag of this repository
  (10, DEL-3).

## 2. Configuration in the consuming workspace

```jsonc
// nx.json
{
  "plugins": [
    {
      "plugin": "nx-s3-serverless-cache",
      "options": {
        "url": "https://nx-cache.example.com",  // required
        "workspace": "web-platform",            // required, matches 03 WS-1
        "region": "eu-west-1",                  // required, deployment region (02 TOK-2)
        "audience": "nx-cache.example.com",     // optional, defaults to the url's host (02 TOK-1)
        "profile": "nx-cache",                  // optional AWS profile
        "tokenLifetimeSeconds": 3600            // optional, default 3600
      }
    }
  ]
}
```

The Terraform module's `plugin_options` output gives `url`, `region` and
`audience` for a deployment (06).

- **CFG-1** Invalid options (missing field, bad URL, bad workspace ID) print one
  error line and disable the remote cache for the run. They MUST NOT fail the
  Nx command.
- **CFG-2** The workspace MUST NOT also configure Nx Cloud or install an
  `@nx/*-cache` package (01, CB-2). The plugin MUST warn when it detects either,
  because Nx would silently ignore our cache.

## 3. Plugin behaviour (`preTasksExecution`)

Runs once before every Nx command that runs tasks.

| # | Step |
|---|---|
| 1 | If `NX_S3_SERVERLESS_CACHE_DISABLED=true`, do nothing. |
| 2 | If `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` is already set, do nothing. This lets CI or a user supply a token made with the CLI. A token the plugin set itself in an earlier command does not count: Nx before 22.7 keeps hook values in the daemon (CQ-8), so the plugin also sets `NX_S3_SERVERLESS_CACHE_ISSUED` to a fingerprint of its token and replaces a token that matches it. |
| 3 | Resolve AWS credentials with the AWS SDK v3 default provider chain, using `profile` if set. This covers environment variables, IAM Identity Center (SSO), shared config files, container credentials (ECS, CodeBuild), EC2 instance metadata and web identity. |
| 4 | Create the token as in 02, section 3, with `X-Amz-Expires = tokenLifetimeSeconds`. |
| 5 | Set `NX_SELF_HOSTED_REMOTE_CACHE_SERVER = <url>/<workspace>` (03, URL-1; or the URL-2 fallback) and `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN = <token>` on `process.env`. |

- **PL-1 Never break the build.** Any failure (no credentials, timeout, bad
  config) prints one warning and sets `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` to
  the empty string, which turns the HTTP cache off for the run. The Nx command
  carries on with its local cache. With the daemon on, Nx sends the hook's
  output to `.nx/workspace-data/d/daemon.log`, not the terminal (CQ-8), so the
  CLI's `check` is the way to diagnose a developer machine.
- **PL-2 Actionable warnings.** For example: `Nx remote cache disabled: no AWS
  credentials found. Run "aws sso login --profile nx-cache".`
- **PL-3 Time budget.** Credential resolution and signing MUST finish within
  5 seconds, or PL-1 applies. Signing itself makes no network call.
- **PL-4 Expiry check.** The token's effective expiry is the earlier of
  now + `tokenLifetimeSeconds` and the credentials' own expiry. If the
  effective lifetime is under 60 minutes (the longest expected command, D-21),
  the plugin warns that the cache may stop working during long runs. It still
  sets the token.
- **PL-5 No secrets in output.** The token and credentials MUST NOT be logged.
  With `NX_VERBOSE_LOGGING=true` the plugin MAY log the credential source,
  region, workspace and effective expiry.

## 4. CLI (`nx-s3-serverless-cache`)

```
nx-s3-serverless-cache token [--format token|env|json]
nx-s3-serverless-cache check
  common options: --url --workspace --region --audience --profile --lifetime
```

- **CLI-1** Options default to the plugin entry in the nearest `nx.json`.
  Command-line flags override them.
- **CLI-2** `token --format token` (default) prints the bare token.
  `--format env` prints `export` lines for both Nx variables, for use with
  `eval "$(npx nx-s3-serverless-cache token --format env)"`. `--format json`
  prints the token, server URL and effective expiry.
- **CLI-3** `check` creates a token and sends `GET` for a fixed probe hash that
  is never stored. Because every failure on `GET` is a `404` (D-34), it reads the
  `x-nx-cache-outcome` header: `miss` (or a `200`) is "authenticated, read
  allowed", `forbidden` is "authenticated, but your role is not on the cache's
  allowed list", `unauthenticated` is "token rejected", `bad_request` is a
  configuration problem, a `404` without the header means the URL is not a
  cache, and anything else is a server problem. Without the header, `401` and
  `403` are read as their usual meanings. Write access cannot be checked
  without writing, and the output says so.
- **CLI-4** Exit codes: `0` success; `1` no credentials or token rejected;
  `2` configuration error; `3` server unreachable or `5xx`.

## 5. Token lifetime

- **LT-1** Client default `tokenLifetimeSeconds` is 3600 (D-21: the longest Nx
  command is under 1 hour, and the plugin mints a fresh token for every
  command).
- **LT-2** Server default `TOKEN_MAX_LIFETIME_SECONDS` is 3600. Both are
  configurable. The server value is a Terraform input.

## 6. Answers from SPIKE-1

- **CQ-8** Without the daemon, the hook sees the invoking shell's environment,
  with plugin isolation on or off. With the daemon on, Nx 21.0.0 to 22.6 run the
  hook with the environment the daemon was started with, and values the hook
  sets stay in the daemon between commands. From 22.7.0 Nx forwards the
  client's environment to the daemon and its plugin workers, and removes keys
  the client does not have. With the daemon on, the hook's output goes to the
  daemon log. On older versions, set `profile`, or stop the daemon after
  changing AWS variables in the shell.
- **CQ-9** Yes, on 21.0.0 and 24.0.1, daemon on or off: Nx tests the variable
  for truthiness.
- **CQ-10** Yes, in every mode on 21.0.0 and 24.0.1 (on 21.0.0 with the daemon,
  from the daemon's environment as in CQ-8). Nx records what the hook sets
  through a proxy on `process.env`, so the plugin reads `process.env` at call
  time. The plugin itself was then checked the same way, from a packed tarball,
  including a second command under the daemon.
