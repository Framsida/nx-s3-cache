# nx-s3-serverless-cache

A self-hosted [Nx remote cache](https://nx.dev/docs/guides/tasks--caching/self-hosted-caching)
on AWS. API Gateway and one Lambda function serve Nx's cache API, artifacts live
in S3, and callers prove who they are with their own AWS IAM credentials. No
shared secret exists anywhere.

This repository ships the Lambda code, a Terraform module and an Nx plugin with
a CLI. You build and apply it from your own repository; nothing here runs
Terraform against AWS. The design is in [`docs/specs`](./docs/specs/README.md).

> **Status.** Implemented and tested offline. SPIKE-2 and the end-to-end suite
> run against a real deployment, which a maintainer makes before the first
> release ([08](./docs/specs/08-testing-and-spikes.md)).

## How it works

```
nx run-many ...
  └─ nx-s3-serverless-cache plugin (preTasksExecution)
       AWS credentials → presigned STS GetCallerIdentity request → bearer token
  └─ Nx HTTP remote cache ── GET|PUT https://<domain>/<workspace>/v1/cache/<hash>
                                    │
       Route 53 → API Gateway (REST, custom domain, TLS 1.2+)
                                    │   PUT only: size gate (same Lambda)
                                    ▼
       Lambda nx-cache-handler ── sends the token to STS → caller's role
                               └─ S3 v1/<workspace>/<hash>, 14-day expiry
```

- **Identity.** The token is a presigned `sts:GetCallerIdentity` request, bound
  to your cache's domain. The handler sends it to STS, which checks the
  signature and returns the caller's role. Only roles on `allowed_role_arns`
  get in.
- **Workspaces.** Any number of Nx workspaces share one deployment, each under
  its own key prefix. Adding one needs no Terraform change.
- **Records are immutable.** An existing hash is never overwritten.
- **The cache never fails your build when it can avoid it.** Nx fails the
  whole command on most HTTP errors (SPIKE-1). So when the handler can't serve
  a request (bad token, role not allowed, upload too large, STS or S3 down), it
  answers with a cache miss for downloads or a skipped upload for uploads. The
  `x-nx-cache-outcome` response header, the logs and the metrics say what
  actually happened.

What still fails an Nx command: anything that stops a request reaching the
handler. That covers API Gateway throttling, a crashed or timed-out Lambda, an
AWS outage, or a wrong URL on upload. Nx gives no way round this
([03 §5.4](./docs/specs/03-architecture-and-request-handling.md)). Set
`NX_S3_SERVERLESS_CACHE_DISABLED=true` to opt a run out.

## Prerequisites

- An AWS account, and a Route 53 **public hosted zone** for the cache's domain.
- An S3 bucket for Terraform state, in your own account.
- Terraform 1.10 or newer and the AWS provider 6.19 or newer.
- Node.js 24 and pnpm (version pinned in `package.json`) to build the Lambda
  package. Building needs no AWS access.
- Consuming workspaces: Nx 21.0.0 or newer, Node.js 20 or newer, and no Nx Cloud
  or `@nx/*-cache` package (Nx would silently prefer those).

## Deploying or upgrading

1. Check out this repository at a release tag, for example `v1.2.0`.
2. Build the Lambda package from source:

   ```sh
   pnpm install --frozen-lockfile
   pnpm nx run cache-handler:package     # → dist/apps/cache-handler/lambda.zip
   ```

   The zip is reproducible: the same tag gives the same `source_code_hash`.

3. In your own Terraform root, call the module from that checkout's
   `terraform/` directory and set `lambda_package_path` to the zip. Module and
   zip must come from the same tag. [`examples/basic`](./examples/basic) is a
   complete root module to copy.

   ```hcl
   module "nx_cache" {
     source = "../nx-s3-serverless-cache/terraform"

     environment         = "prod"
     domain_name         = "nx-cache.example.com"
     hosted_zone_name    = "example.com"
     allowed_role_arns   = ["arn:aws:iam::111111111111:role/ci-runner"]
     alarm_emails        = ["platform-team@example.com"]
     lambda_package_path = "../nx-s3-serverless-cache/dist/apps/cache-handler/lambda.zip"
   }
   ```

4. Initialise with your state bucket:

   ```sh
   terraform init \
     -backend-config="bucket=<state bucket>" \
     -backend-config="key=nx-s3-serverless-cache/<environment>.tfstate" \
     -backend-config="region=<state bucket region>" \
     -backend-config="use_lockfile=true"
   ```

5. `terraform plan`, review, `terraform apply`.
6. On a first deploy, every address in `alarm_emails` confirms the subscription
   email from AWS.
7. From an allowed role, check the deployment with the `plugin_options` output:

   ```sh
   npx nx-s3-serverless-cache check --url https://nx-cache.example.com --region eu-west-1 --workspace smoke-test
   ```

With more than one instance (for example dev and prod), apply and check the
lower one first.

The main module inputs are below. All of them, with their validation, are in
[`terraform/variables.tf`](./terraform/variables.tf).

| Input                                                                                        | Default    | Notes                                                                                                  |
| -------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `environment`, `domain_name`, `hosted_zone_name`, `allowed_role_arns`, `lambda_package_path` | (required) |                                                                                                        |
| `retention_days`                                                                             | 14         | Artifact expiry                                                                                        |
| `max_artifact_bytes`                                                                         | 4194304    | At most 4500000, because of Lambda's 6 MB event                                                        |
| `token_max_lifetime_seconds`                                                                 | 3600       |                                                                                                        |
| `cache_enabled`                                                                              | `true`     | Kill switch                                                                                            |
| `alarm_emails` / `alarm_sns_topic_arn`                                                       | none       | One or the other                                                                                       |
| `admin_role_arns`                                                                            | `[]`       | May delete objects, for purges                                                                         |
| `manage_api_gateway_account`                                                                 | `false`    | Set on one instance per account and region, unless the account already has an API Gateway logging role |

## Connecting a workspace

Install the plugin (until a registry is chosen, from a tarball made with
`pnpm pack` in `packages/nx-s3-serverless-cache`) and add it to `nx.json`:

```jsonc
{
  "plugins": [
    {
      "plugin": "nx-s3-serverless-cache",
      "options": {
        "url": "https://nx-cache.example.com", // from plugin_options
        "region": "eu-west-1", // from plugin_options
        "workspace": "web-platform", // any new ID: lowercase, digits, hyphens
      },
    },
  ],
}
```

Before every Nx command that runs tasks, the plugin makes a fresh one-hour
token from your AWS credentials and points Nx at the cache. Developers sign in
with `aws sso login`; CI in AWS uses its instance or task role. Details and
troubleshooting are in the [package README](./packages/nx-s3-serverless-cache/README.md).

## Routine changes

| Change                           | How                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Add a workspace                  | No Terraform change. Add the plugin entry with a new workspace ID.                     |
| Allow or revoke a role           | Edit `allowed_role_arns` and apply. New requests see the change straight away.         |
| IAM Identity Center role renamed | Re-provisioning a permission set can change its role name. Update `allowed_role_arns`. |
| Change retention                 | Edit `retention_days` and apply. Existing objects follow the new rule.                 |
| Rotate secrets                   | Nothing to rotate: the system holds no secrets.                                        |

## Incidents

**Suspected cache poisoning.** Every listed role can write every workspace
(accepted risk R-1). If a role may have uploaded bad artifacts:

1. Remove it from `allowed_role_arns` and apply.
2. In CloudWatch Logs Insights, on the handler's log group
   (`/aws/lambda/<name_prefix>-<environment>-handler`), list what it wrote:

   ```
   fields @timestamp, workspace, hash, session
   | filter outcome = "stored" and principal = "role:111111111111:ci-runner"
   | fields concat("v1/", workspace, "/", hash) as key
   | sort @timestamp desc
   ```

3. From a role in `admin_role_arns`, delete those keys, for example with
   `aws s3api delete-object --bucket <bucket> --key <key>` for each one.
   Consumers rebuild those tasks on their next miss.

**Purge a workspace.** From an admin role:
`aws s3 rm s3://<bucket>/v1/<workspace>/ --recursive`.

**Kill switch.** Set `cache_enabled = false` and apply. Every request then
becomes a miss or a skipped upload, and no build fails. Don't use
`lambda_reserved_concurrency = 0` for this: requests would fail, and so would
every Nx command.

### Alarm runbook

| Alarm                | Meaning                                                                                                                       | First checks                                                                                         | Likely fixes                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `…-api-5xx-rate`     | Over 5% of requests got a 5xx for 15 min. These fail Nx commands.                                                             | Dashboard (errors, throttles, concurrency); handler `ERROR` logs; AWS Health                         | Lambda errors or throttles (below); a bad deploy (roll back to the previous tag) |
| `…-lambda-errors`    | The handler crashed, timed out or failed its cold start. It answers ordinary failures itself, so errors mean something broke. | Logs for `Invalid configuration` or `Task timed out`; recent applies                                 | Fix the configuration and apply; raise `lambda_timeout_seconds` if S3 is slow    |
| `…-lambda-throttles` | Reserved concurrency or the account limit was reached. Throttled requests fail Nx commands.                                   | `ConcurrentExecutions` on the dashboard; other functions in the account                              | Raise or remove `lambda_reserved_concurrency`; ask AWS for a higher limit        |
| `…-sts-failures`     | STS failed or timed out for many requests. They became misses and skipped uploads.                                            | Handler `ERROR` logs (`errorCode`, `awsRequestId`); AWS Health for STS in the region                 | Usually transient; open an AWS support case if it persists                       |
| `…-s3-failures`      | S3 reads or writes failed.                                                                                                    | Handler `ERROR` logs; the bucket policy (an `AccessDenied` usually means it was changed); AWS Health | Restore the bucket policy by applying; wait out `SlowDown`                       |
| `…-internal-errors`  | The handler hit an unexpected error. The requests became misses or skipped uploads.                                           | Logs with `outcome = "internal_error"` (`errorCode`, `reason`)                                       | Report it with the log line; roll back if a release caused it                    |

## Developing this repository

```
apps/cache-handler/            Lambda handler (specs 02, 03, 04, 07)
packages/token-format/         Shared constants and types
packages/nx-s3-serverless-cache/  Nx plugin and CLI (spec 05)
terraform/                     The module, with offline tests (spec 06)
examples/basic/                Example root module, never applied here
e2e/                           End-to-end suite against a deployment (spec 08 §5)
tools/spike-stub-server/       SPIKE-1 stub server and results
tools/scripts/                 Reproducible zip
docs/specs/                    Specifications
```

```sh
pnpm install
pnpm nx run-many -t lint typecheck test build      # TypeScript projects
pnpm nx run cache-handler:package                  # lambda.zip
pnpm nx run-many -t fmt-check validate tflint tf-test -p terraform   # needs terraform and tflint
pnpm prettier --check .
```

CI runs all of these on every pull request without AWS credentials
([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)). The end-to-end
suite needs a deployment; see [`e2e/README.md`](./e2e/README.md).

A release is a `vX.Y.Z` tag on the default branch. It versions the handler, the
module and the package together. Before tagging, set the version of
`packages/nx-s3-serverless-cache/package.json` to match the tag, and run the
end-to-end suite against a test deployment.
