# 04 — Storage

| | |
|---|---|
| Status | Draft |
| Depends on | [03](./03-architecture-and-request-handling.md) |
| Decisions | D-16 (isolated workspaces), D-17 (14-day retention), D-18 (SSE-S3) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Bucket

- **S3-1** One bucket per environment. Its name is a Terraform input.
- **S3-2** All four Block Public Access settings are on.
- **S3-3** Object Ownership is `BucketOwnerEnforced` (ACLs disabled).
- **S3-4** Default encryption is SSE-S3 (`AES256`).
- **S3-5** Versioning is **disabled**. Records are protected from replacement by
  conditional writes (03, 5.3), and versioning would keep expired data around
  and add cost.
- **S3-6** Storage class is S3 Standard. Objects live 14 days, so the 30-day
  minimum charge of the Infrequent Access classes would cost more, not less.

## 2. Bucket policy

- **S3-POL-1** Deny any request where `aws:SecureTransport` is `false`.
- **S3-POL-2** Deny `s3:GetObject` and `s3:PutObject` on `v1/*` to every
  principal except the handler's execution role and a break-glass administrator
  role (a Terraform input). This keeps other identities in the account out of
  the cache data, even if their IAM policies would allow it.
- **S3-POL-3** Deletion is allowed only for the lifecycle service and the
  break-glass role (for purges, R1-M4 in 02).

## 3. Key layout

```
v1/<workspace>/<hash>
```

- **KEY-1** `v1/` versions the layout, so a later layout can live alongside
  this one during a migration.
- **KEY-2** `<workspace>` and `<hash>` are validated before use (03, step 2),
  so a key can never escape its workspace prefix.
- **KEY-3** No other objects are written under `v1/`.

## 4. Object metadata

Every object is written with:

| Field | Value |
|---|---|
| `Content-Type` | `application/octet-stream` |
| `x-amz-meta-writer` | Normalized principal, for example `role:123456789012:ci-runner` (02, 5.1) |
| `x-amz-meta-writer-session` | Role session name, truncated to 64 characters |
| `x-amz-meta-nx-workspace` | Workspace ID |
| SHA-256 checksum | Calculated by the handler and checked by S3 on upload |

Upload time is the object's `LastModified`.

## 5. Lifecycle

- **LC-1** Expire objects under `v1/` 14 days after creation. The number of days
  is a Terraform input, `retention_days`, default 14.
- **LC-2** Abort incomplete multipart uploads after 1 day. (The handler uses
  single-part uploads; this is a safety net.)
- **LC-3** Expiry counts from creation, not from last read. A popular artifact is
  deleted after 14 days and stored again by the next build that misses it.
  This is accepted.

## 6. Audit and purge (R1-M3, R1-M4 in 02)

- **AUD-1** The handler writes one structured log line per successful `PUT`,
  with the workspace, hash, size, normalized principal and session name.
- **AUD-2** The handler's log retention MUST be at least `retention_days`, so
  every object still stored can be traced to its writer.
- **AUD-3** Purge procedure: a CloudWatch Logs Insights query over AUD-1 lines
  lists the keys written by a given principal or session. The break-glass role
  then deletes them. Runbook in [09](./09-operations.md), OPS-1.
