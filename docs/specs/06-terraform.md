# 06 — Terraform module

| | |
|---|---|
| Status | Draft |
| Depends on | [03](./03-architecture-and-request-handling.md), [04](./04-storage.md), [07](./07-observability.md) |
| Decisions | D-6, D-20 (several instances per account), D-27 (allowed role ARNs), D-28 (region and domain inputs), D-29 (backend at init), D-30 (no Terraform runs from this repo), D-31 (build from source), D-33 (alarms to the deployer), D-35 (kill switch), D-36 (size gate) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Scope and layout

This repository ships a reusable Terraform module and an example of how to call
it. Deployers apply it from their own repositories (D-30).

```
terraform/                 # the module: everything in 03, 04 and 07
  versions.tf  variables.tf  main.tf  ...  outputs.tf
  tests/*.tftest.hcl       # offline tests with a mocked AWS provider
examples/
  basic/                   # example root module; never applied from this repo
```

- **TF-1** This repository MUST NOT contain environment roots, state, real
  variable values or AWS credentials. Nothing in it, CI included, runs
  `terraform plan` or `apply` against AWS.
- **TF-2** The module creates one complete cache instance. A deployer MAY create
  several instances in one account and region (for example, dev and prod).
  Every resource name starts with `<name_prefix>-<environment>`, so instances
  never collide (D-20).
- **TF-3 Region.** The module takes the region from the AWS provider it is given
  and has no region input of its own. It reads the region with
  `data "aws_region"` for `STS_REGION`, and outputs it. The deployer's root
  module takes the region as a variable and sets it on the provider (the example
  does this).
- **TF-4 Hosted zone.** The Route 53 public hosted zone MUST already exist. The
  module looks it up by `hosted_zone_name`, so the plan fails if the zone is
  missing. A precondition checks that `domain_name` is the zone name or ends
  with `.<zone name>`.
- **TF-5 No hard-coding.** No account IDs, regions, ARNs or domain names in the
  module.
- **TF-6 Versions.** Terraform `>= 1.10, < 2.0` (1.10 adds S3-native state
  locking, used in the example). AWS provider `>= 6.19, < 7.0`: 6.19.0 is the
  first 6.x release that accepts the `nodejs24.x` runtime. The offline tests
  (TF-12) need Terraform 1.11 or newer, for `override_during`.
- **TF-7 Tags.** Every taggable resource gets
  `Project = nx-s3-serverless-cache`, `Environment = <environment>`, merged
  with the `tags` input.

## 2. Module inputs

| Input | Type | Default | Validation / notes |
|---|---|---|---|
| `environment` | string | — | `^[a-z0-9-]{1,16}$`, e.g. `dev`, `prod` |
| `name_prefix` | string | `nx-cache` | Lowercase letters, digits, hyphens |
| `domain_name` | string | — | e.g. `nx-cache.example.com` (TF-4) |
| `hosted_zone_name` | string | — | Existing public zone, e.g. `example.com` (TF-4) |
| `allowed_role_arns` | list(string) | — | At least one. Exact IAM role ARNs from any account. Each matches 02 AUTHZ-5. No duplicates after normalization (02 AUTHZ-2). |
| `lambda_package_path` | string | — | Path to the zip built from source (10, section 3). The file must exist. |
| `bucket_name` | string | `<name_prefix>-<environment>-artifacts-<account id>` | S3 naming rules |
| `retention_days` | number | 14 | ≥ 1 (D-17) |
| `token_audience` | string | `domain_name` | 02 TOK-1 |
| `token_max_lifetime_seconds` | number | 3600 | 900–43200 |
| `max_artifact_bytes` | number | 4194304 | ≤ 4500000 (03, SIZE-1) |
| `lambda_memory_mb` | number | 1024 | |
| `lambda_timeout_seconds` | number | 20 | < 29 |
| `lambda_reserved_concurrency` | number | `null` (none) | ≥ 0 when set. Not set by default, because new accounts can have very low concurrency quotas. Not a kill switch: `0` fails every Nx command. |
| `cache_enabled` | bool | `true` | `false` makes every request a miss or a skipped upload (D-35) |
| `api_throttle_rate_limit` | number | 100 | Requests per second |
| `api_throttle_burst_limit` | number | 200 | |
| `log_retention_days` | number | 30 | ≥ `retention_days` (04, AUD-2); a value CloudWatch supports |
| `alarms_enabled` | bool | `true` | 07, ALM-1 |
| `alarm_emails` | list(string) | `[]` | 07 section 4. Not allowed together with `alarm_sns_topic_arn`. |
| `alarm_sns_topic_arn` | string | `null` | An existing topic to send alarms to, instead of creating one |
| `alarm_thresholds` | object | see 07 section 4 | `api_5xx_rate_percent`, `api_5xx_min_requests`, `sts_failures`, `s3_failures` |
| `admin_role_arns` | list(string) | `[]` | Roles exempted from the bucket policy's deny, for purges (04, S3-POL-2) |
| `manage_api_gateway_account` | bool | `false` | TF-10 |
| `tags` | map(string) | `{}` | |

- **TF-8** The Lambda environment variables (03, FN-5) are built from these
  inputs. A precondition on the function MUST fail the plan if their combined
  size exceeds 4 KB.

## 3. Resources in the module

| Area | Resources |
|---|---|
| Lookups | `data.aws_region`, `data.aws_caller_identity`, `data.aws_partition`, `data.aws_route53_zone` (by `hosted_zone_name`, public) |
| Storage (04) | `aws_s3_bucket`, `aws_s3_bucket_public_access_block`, `aws_s3_bucket_ownership_controls`, `aws_s3_bucket_server_side_encryption_configuration`, `aws_s3_bucket_lifecycle_configuration`, `aws_s3_bucket_policy` |
| Function (03 §4) | `aws_iam_role`, `aws_iam_role_policy`, `aws_cloudwatch_log_group`, `aws_lambda_function` (`nodejs24.x`, `arm64`, JSON log format, code from `lambda_package_path` with `source_code_hash`), two `aws_lambda_permission`s for API Gateway (the route and the size gate) |
| API (03 §3) | `aws_api_gateway_rest_api` (REGIONAL, `binary_media_types = ["*/*"]`, `disable_execute_api_endpoint = true`, an OpenAPI `body` with the routes, the size gate and one gateway response per row in APIGW-5; separate `aws_api_gateway_gateway_response` resources would be deleted whenever the body is re-imported), `aws_api_gateway_deployment`, `aws_api_gateway_stage` (access logs), `aws_api_gateway_method_settings` (throttling on, metrics on, execution logging and data trace off), log group for access logs |
| Domain | `aws_acm_certificate` with DNS validation records in the existing zone and `aws_acm_certificate_validation`, `aws_api_gateway_domain_name` (REGIONAL, TLS 1.2 minimum), `aws_api_gateway_base_path_mapping`, `aws_route53_record` alias |
| Observability (07) | `aws_sns_topic` and email subscriptions (only when `alarm_sns_topic_arn` is not set), `aws_cloudwatch_metric_alarm`s, `aws_cloudwatch_log_metric_filter`s, `aws_cloudwatch_dashboard`, a `check` block for missing alarm recipients (07, ALM-2) |

- **TF-9** The REST API deployment MUST be re-created when the OpenAPI body
  changes (a `triggers` hash). The body holds the routes, the integration, the
  size gate and the gateway responses, so every change goes live.
- **TF-10** API Gateway access logging needs a CloudWatch Logs role set at the
  account and region level (`aws_api_gateway_account`). There is only one such
  setting per account and region, shared by every instance and anything else in
  the account. The module creates it only when
  `manage_api_gateway_account = true`, and at most one instance per account and
  region may set that. If the account already has the role, leave it `false`.

## 4. Outputs

`endpoint_url`, `region`, `rest_api_id`, `stage_name`, `bucket_name`,
`lambda_function_name`, `lambda_role_arn`, `alarm_topic_arn`, and
`plugin_options`: an object with `url`, `region` and `audience`, ready to paste
into a workspace's `nx.json` (05, section 2).

## 5. Example root module (`examples/basic`)

Shows a deployer how to call the module. It is checked in CI (TF-11) but never
applied from this repository.

- **EX-1** Variables: `region`, `environment`, `domain_name`, `hosted_zone_name`,
  `allowed_role_arns`, `alarm_emails`, `lambda_package_path`.
- **EX-2** `provider "aws" { region = var.region }`.
- **EX-3** The backend block is empty, `backend "s3" {}`. The state bucket, key,
  region and locking are passed at `terraform init` (D-29):

  ```
  terraform init \
    -backend-config="bucket=<state bucket>" \
    -backend-config="key=nx-s3-serverless-cache/<environment>.tfstate" \
    -backend-config="region=<state bucket region>" \
    -backend-config="use_lockfile=true"
  ```

- **EX-4** The module source is a local path to a checkout of this repository at
  a release tag, the same checkout the Lambda zip was built from (09, section 1).
  This keeps module and code versions in step.

## 6. Checks (offline only)

- **TF-11** `terraform fmt -check`, `terraform init -backend=false`,
  `terraform validate` and `tflint` pass for the module and the example.
- **TF-12** `terraform test` with a mocked AWS provider covers every input
  validation in section 2, and the preconditions in TF-4 and TF-8. These tests
  need no AWS credentials and create nothing.
