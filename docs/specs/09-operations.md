# 09 — Operations

| | |
|---|---|
| Status | Draft |
| Depends on | [04](./04-storage.md), [06](./06-terraform.md), [07](./07-observability.md) |
| Decisions | D-29, D-30, D-31, D-33 |

Whoever deploys an instance operates it: they apply it, receive its alarms and
run these procedures. Everything here runs from the deployer's own repository
and machines, never from this one (D-30). This document becomes the deployer
guide in the repository README.

## 1. Deploying or upgrading

1. Check out this repository at a release tag, for example `v1.2.0`.
2. Build the Lambda package from source (D-31):
   `pnpm install --frozen-lockfile && pnpm nx run cache-handler:package`.
   This writes `dist/apps/cache-handler/lambda.zip` (10, section 3).
3. In the deployer's own Terraform root, call the module from that checkout's
   `terraform/` directory. Set `lambda_package_path` to the zip from step 2 (06,
   EX-4). Module and zip MUST come from the same tag.
4. `terraform init` with the backend settings (06, EX-3).
5. `terraform plan`, review, `terraform apply`.
6. On first deploy, every address in `alarm_emails` confirms the SNS
   subscription email from AWS.
7. From an allowed role, run `npx nx-s3-serverless-cache check` with the
   `plugin_options` output.

Deployers with more than one instance (for example, dev and prod) SHOULD apply
and check the lower one first.

## 2. Routine changes

| Change | How |
|---|---|
| Add a workspace | No Terraform change (03, WS-2). Add the plugin entry to the workspace's `nx.json`, using the `plugin_options` output and a new workspace ID. |
| Allow or revoke a role | Edit `allowed_role_arns`, apply. The configuration change replaces running Lambda environments, so it takes effect for new requests straight away. |
| SSO role renamed | When an IAM Identity Center permission set is re-provisioned, its role name can change. Update `allowed_role_arns` (02, AUTHZ-3). |
| Change retention | Edit `retention_days`, apply. Existing objects follow the new rule. |
| Rotate secrets | Nothing to rotate: the system holds no secrets. |

## 3. Incidents

- **OPS-1 Suspected cache poisoning (R-1).** Remove the writer's role from
  `allowed_role_arns` and apply. Then purge what it wrote (04, AUD-3): a Logs
  Insights query lists the keys, and an admin role (`admin_role_arns`) deletes
  them. Consumers rebuild those tasks on the next miss.
- **OPS-2 Purge a whole workspace.** An admin role deletes the prefix
  `v1/<workspace>/`.
- **OPS-3 Kill switch.** Set `lambda_reserved_concurrency` to 0 and apply (or set
  it directly on the function in an emergency). Every request then fails. How Nx
  behaves in that case is confirmed by SPIKE-1 (01, CQ-5). Individual users can
  opt out with `NX_S3_SERVERLESS_CACHE_DISABLED=true` (05).
- **OPS-4 Alarms.** Each alarm in 07 section 4 gets a runbook entry in the
  deployer guide: what it means, the first checks (dashboard, handler `ERROR`
  logs, AWS Health), and likely fixes.
