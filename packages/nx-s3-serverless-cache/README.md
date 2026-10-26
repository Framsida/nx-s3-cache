# nx-s3-serverless-cache

Nx plugin and CLI for an [nx-s3-serverless-cache](../../README.md) deployment: a
self-hosted Nx remote cache on AWS that you sign in to with your own AWS IAM
credentials.

- Nx 21.0.0 or newer, Node.js 20 or newer.
- The workspace must not use Nx Cloud or an `@nx/*-cache` package. Nx would
  prefer those and silently ignore this cache; the plugin warns when it sees
  one.

## Set up

```jsonc
// nx.json
{
  "plugins": [
    {
      "plugin": "nx-s3-serverless-cache",
      "options": {
        "url": "https://nx-cache.example.com", // required
        "workspace": "web-platform", // required: lowercase letters, digits, hyphens
        "region": "eu-west-1", // required: the region the cache is deployed in
        "audience": "nx-cache.example.com", // optional, defaults to the url's host
        "profile": "nx-cache", // optional AWS profile
        "tokenLifetimeSeconds": 3600, // optional, default 3600
      },
    },
  ],
}
```

The deployment's Terraform output `plugin_options` gives `url`, `region` and
`audience`.

Before every Nx command that runs tasks, the plugin:

1. does nothing if `NX_S3_SERVERLESS_CACHE_DISABLED=true`;
2. does nothing if `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` is already set
   (CI or you supplied a token, for example with the CLI);
3. gets AWS credentials from the standard chain: environment variables, IAM
   Identity Center, shared config, ECS and CodeBuild container credentials, EC2
   instance metadata, web identity;
4. makes a token: a presigned STS `GetCallerIdentity` request. Your secret key
   never leaves your machine, and making the token needs no network call;
5. sets `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` and
   `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` for the run.

If anything goes wrong (no credentials, an expired SSO session, bad options,
more than 5 seconds spent), the plugin prints one line and turns the remote
cache off for that run. The build carries on with the local cache.

## CLI

```
npx nx-s3-serverless-cache check
npx nx-s3-serverless-cache token [--format token|env|json]
  options: --url --workspace --region --audience --profile --lifetime
```

Options default to the plugin entry in the nearest `nx.json`; flags override
them.

- `check` asks the cache for a hash that is never stored, and says whether your
  role can read. Write access can't be checked without writing; every role that
  can read can also write. Exit codes: `0` ok, `1` no credentials, token
  rejected or role not allowed, `2` configuration error, `3` server unreachable
  or failing.
- `token --format env` prints `export` lines for both Nx variables, for scripts
  or CI that cannot run the plugin:

  ```sh
  eval "$(npx nx-s3-serverless-cache token --format env)"
  ```

## Troubleshooting

- **Start with `npx nx-s3-serverless-cache check`.** It reports what the
  cache made of your token.
- **No plugin messages with the Nx daemon on.** Nx runs the hook inside the
  daemon, so its messages go to `.nx/workspace-data/d/daemon.log`, not your
  terminal. Run with `NX_DAEMON=false` to see them.
- **Nx before 22.7 with the daemon.** These versions run the hook with the
  environment the daemon started with: an `AWS_PROFILE` or AWS keys exported
  in your shell later are not seen. Set `profile` in the plugin options, or run
  `nx daemon --stop` after changing AWS variables.
- **The cache seems to do nothing.** Failures never fail your build: a rejected
  token, an unlisted role or an upload over the size limit turns into a cache
  miss or a skipped upload. `check` and the cache's logs say which.
- **Uploads skipped for big outputs.** Task outputs over the deployment's limit
  (4 MiB by default) are not cached remotely.
- **A long run loses the cache.** Tokens last an hour, or less if your
  credentials expire sooner; the plugin warns in that case. Refresh your
  credentials before long runs.
