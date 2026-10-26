# 06 — Terraform modules and environments

| | |
|---|---|
| Status | Draft |
| Depends on | [03](./03-architecture-and-request-handling.md), [04](./04-storage.md), [07](./07-observability.md) |
| Decisions | D-6, D-20 (dev and prod in one account), D-24 (manual apply), D-25 (existing S3 backend) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Layout

```
infra/
  modules/
    nx-cache/          # one complete environment (everything in 03, 04, 07)
  envs/
    dev/               # root module: backend, provider, module call, tfvars
    prod/
```

- **TF-1** All resources for one environment live in the `nx-cache` module. The
  `envs/*` roots only set the backend, the provider and the module inputs.
- **TF-2** Each environment has its own state key in the existing S3 backend
  (D-25). Backend details are open (Q-9b).
- **TF-3** Dev and prod share one AWS account (D-20). Every resource name starts
  with `<name_prefix>-<environment>`, so the two never collide.
- **TF-4** No account IDs, regions or ARNs are hard-coded in the module. They
  come from inputs or data sources.
- **TF-5** Version constraints: Terraform `>= 1.10, < 2.0`, AWS provider
  `~> 6.0`. Adjust if the existing backend conventions say otherwise (Q-9b).
- **TF-6** Tags: the provider's `default_tags` sets `Project = nx-cache`,
  `Environment`, `ManagedBy = terraform`, merged with a `tags` input.

## 2. Module inputs

| Input | Type | Default | Validation / notes |
|---|---|---|---|
| `environment` | string | — | `dev` or `prod` |
| `name_prefix` | string | — | Lowercase, hyphens |
| `domain_name` | string | — | e.g. `nx-cache.dev.example.com` (Q-9a) |
| `hosted_zone_id` | string | — | Route 53 zone for `domain_name` |
| `bucket_name` | string | `<name_prefix>-<environment>-artifacts-<account id>` | S3 naming rules |
| `retention_days` | number | 14 | ≥ 1 (D-17) |
| `workspaces` | list(string) | — | Each matches 03 WS-1; no duplicates |
| `access_rules` | list(object) | — | 02 section 5.2: 12-digit account, pattern with an optional trailing `*` only, known workspaces or `*`, permissions ⊆ {read, write} |
| `token_audience` | string | `nx-cache:<environment>` | |
| `token_max_lifetime_seconds` | number | 3600 | 900–43200 |
| `max_artifact_bytes` | number | 4194304 | ≤ 4500000 (03, SIZE-1) |
| `lambda_memory_mb` | number | 1024 | |
| `lambda_timeout_seconds` | number | 20 | < 29 |
| `lambda_reserved_concurrency` | number | 50 | ≥ 1 |
| `api_throttle_rate_limit` | number | 100 | Requests per second |
| `api_throttle_burst_limit` | number | 200 | |
| `log_retention_days` | number | 30 | ≥ `retention_days` (04, AUD-2); a CloudWatch-supported value |
| `alarm_emails` | list(string) | `[]` | SNS email subscriptions (07) |
| `alarms_enabled` | bool | `true` | Dev MAY turn alarms off |
| `break_glass_role_arn` | string | — | 04, S3-POL-2 |
| `lambda_package_path` | string | — | Path to the built zip (10, section 3) |
| `manage_api_gateway_account` | bool | `false` | See TF-9 |
| `tags` | map(string) | `{}` | |

- **TF-7** The Lambda environment variables (03, FN-5) are built from these
  inputs. A `precondition` on the function MUST fail the plan if their combined
  size exceeds 4 KB.

## 3. Resources in the module

| Area | Resources |
|---|---|
| Storage (04) | `aws_s3_bucket`, `aws_s3_bucket_public_access_block`, `aws_s3_bucket_ownership_controls`, `aws_s3_bucket_server_side_encryption_configuration`, `aws_s3_bucket_lifecycle_configuration`, `aws_s3_bucket_policy` |
| Function (03 §4) | `aws_iam_role`, `aws_iam_role_policy`, `aws_cloudwatch_log_group`, `aws_lambda_function` (runtime `nodejs24.x`, `arm64`, JSON log format), `aws_lambda_permission` for API Gateway |
| API (03 §3) | `aws_api_gateway_rest_api` (REGIONAL, `binary_media_types = ["*/*"]`, `disable_execute_api_endpoint = true`, routes defined by an OpenAPI `body`), `aws_api_gateway_gateway_response` (one per row in APIGW-5), `aws_api_gateway_deployment`, `aws_api_gateway_stage` (access logs), `aws_api_gateway_method_settings` (throttling on, metrics on, execution logging and data trace off), log group for access logs |
| Domain | `aws_acm_certificate` with DNS validation records and `aws_acm_certificate_validation`, `aws_api_gateway_domain_name` (REGIONAL, TLS 1.2 minimum), `aws_api_gateway_base_path_mapping`, `aws_route53_record` alias |
| Observability (07) | `aws_sns_topic` and subscriptions, `aws_cloudwatch_metric_alarm`s, `aws_cloudwatch_log_metric_filter`s, `aws_cloudwatch_dashboard` |

- **TF-8** The REST API deployment MUST be re-created when the OpenAPI body,
  gateway responses or integration change (a `triggers` hash), so changes
  actually go live.
- **TF-9** API Gateway access logging needs a CloudWatch Logs role set at the
  account and region level (`aws_api_gateway_account`). There is only one such
  setting per account and region, shared by dev, prod and anything else in the
  account. The module creates it only when `manage_api_gateway_account = true`,
  and at most one environment may set that. If the account already has the
  role, both stay `false`.

## 4. Outputs

`endpoint_url`, `rest_api_id`, `stage_name`, `bucket_name`,
`lambda_function_name`, `lambda_role_arn`, `sns_topic_arn`, and
`plugin_options`: an object with `url`, `region` and `audience`, ready to paste
into a workspace's `nx.json` (05, section 2).

## 5. Checks

- **TF-10** `terraform fmt -check`, `terraform validate` and `tflint` pass for the
  module and both roots.
- **TF-11** `terraform test` with a mocked AWS provider covers every input
  validation in section 2 and the precondition in TF-7. These tests need no
  AWS credentials.
- **TF-12** Applies are manual (D-24). The procedure is in 09.
