# 09 — Operations

| | |
|---|---|
| Status | Draft |
| Depends on | [04](./04-storage.md), [06](./06-terraform.md), [07](./07-observability.md) |
| Decisions | D-24 (manual apply) |

## 1. Deploying

1. Build the Lambda package (10, section 3).
2. `terraform plan` in `infra/envs/dev`. Review it.
3. `terraform apply` in dev.
4. Run the end-to-end suite against dev (08, section 5).
5. Repeat steps 2–3 in `infra/envs/prod`, with the same commit.
6. Run `nx-cache-token check` against prod from an allowed role.

Prod is applied only from a commit that has passed step 4 in dev.

## 2. Routine changes

| Change | How |
|---|---|
| Add a workspace | Add it to `workspaces`, give roles access in `access_rules`, apply. Add the plugin entry to the workspace's `nx.json`, using the `plugin_options` output. |
| Allow or revoke a role | Edit `access_rules`, apply. Takes effect on the next cold start, or within 5 minutes for cached authorizations (02, VAL-3). |
| Change retention | Edit `retention_days`, apply. Existing objects follow the new rule. |
| Rotate secrets | Nothing to rotate: the system holds no secrets. |

## 3. Incidents

- **OPS-1 Suspected cache poisoning (R-1).** Revoke the writer's rule, then purge
  what it wrote (04, AUD-3): a Logs Insights query lists the keys, and the
  break-glass role deletes them. Consumers then rebuild those tasks on the next
  miss.
- **OPS-2 Purge a whole workspace.** The break-glass role deletes the prefix
  `v1/<workspace>/`.
- **OPS-3 Kill switch.** Set `lambda_reserved_concurrency` to 0 and apply (or
  set it directly in an emergency). Every request then fails. How Nx behaves in
  that case is confirmed by SPIKE-1 (01, CQ-5). Individual users can opt out
  with `NX_IAM_CACHE_DISABLED=true` (05).
- **OPS-4 Alarms.** Each alarm in 07 section 4 needs a runbook entry: what it
  means, the first checks (dashboard, handler `ERROR` logs, AWS Health), and
  the escalation path. Content to be written with the operating team.
