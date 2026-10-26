# 05 — Client tooling: Nx plugin and token CLI

| | |
|---|---|
| Status | Draft |
| Depends on | [02](./02-authentication-and-authorization.md), [03](./03-architecture-and-request-handling.md) |
| Decisions | D-14 (plugin + CLI), D-21 (commands under 1 hour), D-22 (Nx 21 or newer) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Package

- **PKG-1** One npm package (name and registry open: Q-17) holds:
  - the Nx plugin entry point, exporting `preTasksExecution`;
  - a CLI binary, `nx-cache-token`;
  - a shared library that creates tokens, used by both.
- **PKG-2** Supported Nx versions: 21.0.0 or newer (D-22). Both the HTTP remote
  cache and the `preTasksExecution` env propagation exist from 20.8.0, so 21.0.0
  is a safe floor.
- **PKG-3** Supported Node.js versions: those supported by the Nx versions in
  PKG-2 (Node.js 20 or newer). Set in `engines`.
- **PKG-4** Runtime dependencies are limited to the AWS SDK v3 credential
  providers and the SigV4 signer. No AWS service clients are needed.

## 2. Configuration in the consuming workspace

```jsonc
// nx.json
{
  "plugins": [
    {
      "plugin": "<package name>",
      "options": {
        "url": "https://nx-cache.example.com",  // required
        "workspace": "web-platform",            // required, matches 03 WS-1
        "region": "eu-west-1",                  // required, STS region (02 TOK-2)
        "audience": "nx-cache:prod",            // required (02 TOK-1)
        "profile": "nx-cache",                  // optional AWS profile
        "tokenLifetimeSeconds": 3600            // optional, default 3600
      }
    }
  ]
}
```

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
| 1 | If `NX_IAM_CACHE_DISABLED=true`, do nothing. |
| 2 | If `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` is already set, do nothing. This lets CI or a user supply a token made with the CLI. |
| 3 | Resolve AWS credentials with the AWS SDK v3 default provider chain, using `profile` if set. This covers environment variables, IAM Identity Center (SSO), shared config files, container credentials (ECS, CodeBuild), EC2 instance metadata and web identity. |
| 4 | Create the token as in 02, section 3, with `X-Amz-Expires = tokenLifetimeSeconds`. |
| 5 | Set `NX_SELF_HOSTED_REMOTE_CACHE_SERVER = <url>/<workspace>` (03, URL-1; or the URL-2 fallback) and `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN = <token>` on `process.env`. |

- **PL-1 Never break the build.** Any failure (no credentials, timeout, bad
  config) prints one warning and sets `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` to
  the empty string, which turns the HTTP cache off for the run. The Nx command
  carries on with its local cache.
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

## 4. CLI (`nx-cache-token`)

```
nx-cache-token [token] [--format token|env|json]
nx-cache-token check
  common options: --url --workspace --region --audience --profile --lifetime
```

- **CLI-1** Options default to the plugin entry in the nearest `nx.json`.
  Command-line flags override them.
- **CLI-2** `token --format token` (default) prints the bare token.
  `--format env` prints `export` lines for both Nx variables, for use with
  `eval "$(nx-cache-token --format env)"`. `--format json` prints the token,
  server URL and effective expiry.
- **CLI-3** `check` creates a token and sends `GET` for a fixed probe hash that
  is never stored. It reports `404` as "authenticated, read allowed", `403` as
  "authenticated, not allowed into this workspace", `401` as "token rejected",
  and anything else as a server problem. Write access cannot be checked without
  writing, and the output says so.
- **CLI-4** Exit codes: `0` success; `1` no credentials or token rejected;
  `2` configuration error; `3` server unreachable or `5xx`.

## 5. Token lifetime (AQ-2)

- **LT-1** Client default `tokenLifetimeSeconds` is 3600 (D-21: the longest Nx
  command is under 1 hour, and the plugin mints a fresh token for every
  command).
- **LT-2** Server default `TOKEN_MAX_LIFETIME_SECONDS` is 3600. Both are
  configurable. The server value is a Terraform input.

## 6. Questions for SPIKE-1

- **CQ-8** With the Nx daemon on, the hook runs in the daemon or in a plugin
  worker. Does it see the invoking shell's AWS environment (`AWS_PROFILE`,
  `AWS_ACCESS_KEY_ID` and so on), or the environment from when the daemon
  started? Test with the daemon on and off, and with plugin isolation on and off.
- **CQ-9** Does setting `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` to the empty
  string from the hook turn the HTTP cache off on every supported Nx version
  (PL-1)?
- **CQ-10** Is a value set by the hook visible to the Rust client in every
  supported Nx version (PC-5)?
