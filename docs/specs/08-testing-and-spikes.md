# 08 — Testing and spikes

| | |
|---|---|
| Status | Draft |
| Depends on | all other specs |
| Decisions | D-22 (Nx 21 floor), D-23 (Vitest) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Spikes (before implementation)

### SPIKE-1 — Nx client behaviour

**Done.** Tool and results: [`tools/spike-stub-server`](../../tools/spike-stub-server/README.md).
Answers are in 01 §5 and 05 §6, and led to D-34 to D-38.

A throwaway stub HTTP server, written in TypeScript, logs every request and
returns scripted responses. Real Nx workspaces run against it, on Nx 21.0.0 and
on the latest Nx.

- **SP1-1** It MUST answer 01 CQ-1 to CQ-7 and 05 CQ-8 to CQ-10. It MUST record
  real hash values, so the hash pattern in 01 CON-2 can be fixed.
- **SP1-2** Results are written back into 01, 03 and 05: which of URL-1 or URL-2
  is used, the hash pattern, and how the client handles each status.
- **SP1-3** Handler implementation MUST NOT start until SPIKE-1 has finished.
  Its results decide the URL layout and the error handling.

### SPIKE-2 — Deployed stack

Run against a test deployment that a maintainer makes from outside this
repository (D-30). Afterwards it becomes part of the end-to-end suite in
section 5.

- **SP2-1** Byte-for-byte round trips of artifacts at 0 B, 1 B, 1 MiB and the
  size limit (03, APIGW-4).
- **SP2-2** Every gateway response in 03 APIGW-5 reaches Nx as `text/plain`.
- **SP2-3** The status and message Nx shows for a body above the Lambda event
  limit (03, SIZE-3): with the size gate (D-36), a `403` for 4.5 to 10 MB and
  for bodies over 10 MB.
- **SP2-4** A `Content-Length` header reaches the handler in the proxy event:
  any successful `PUT` shows it.
- **SP2-5** The handler's log lines appear in CloudWatch as top-level JSON, not
  wrapped in `message`, and the `NxCache` metrics are extracted from them
  (07, LOG-1).

SP2-1 to SP2-4 are automated in `e2e/suites/deployment.e2e.test.ts`; SP2-5 is
checked by hand after a run.

## 2. Unit tests (Vitest)

- **UT-1 Token validation.** Every row of the step table in 02 section 4 has at
  least one rejecting test and one accepting test. SSRF cases are required:
  - look-alike hosts (`sts.eu-west-1.amazonaws.com.evil.example`),
  - user info, explicit ports, IP literals, a trailing dot, uppercase hosts,
    percent-encoded hosts,
  - `http` scheme, a non-root path, repeated or extra query parameters,
  - audience header not signed, expired tokens, tokens dated in the future,
    oversized tokens, invalid base64url.
- **UT-2 Identity and allowed roles.** ARN normalization for every row in 02
  table 5.1. Allowed-role matching (02, AUTHZ-2): configured ARNs with and
  without IAM paths, role-name case differences, the same role name in two
  accounts where only one is listed, and no match. Rejection of invalid
  configured ARNs (AUTHZ-5). Terraform reduces configured ARNs to
  `<account>:<role name>`, so that part, and the ARN validation, are tested in
  `terraform/tests` (TF-12).
- **UT-3 Request handling.** Every row of 03 table 5.1 and every status in table
  5.4. Path traversal attempts in `workspace` and `hash` (`..`, `%2F`, encoded
  Unicode, empty segments).
- **UT-4 Storage mapping.** S3 errors are mapped as in 03 sections 5.2 and 5.3
  (`NoSuchKey`, `PreconditionFailed`, `ConditionalRequestConflict`, other
  errors), with the S3 client mocked.
- **UT-5 Config.** Cold-start validation of every environment variable (03, FN-7).
- **UT-6 Client token creation.** A known-answer test, with fixed credentials
  and a fixed clock, compares our token with an independently computed
  presigned URL.
- **UT-7 Plugin and CLI.** Plugin steps 1–5 and PL-1 to PL-5 (05), and CLI
  formats and exit codes (CLI-1 to CLI-4).

## 3. Contract tests

- **CT-1** For every operation and status code, the handler's response is
  checked against [`nx-remote-cache.openapi.json`](./nx-remote-cache.openapi.json):
  status, content type and body shape (01, CON-1).

## 4. Integration tests (local, no AWS account)

- **IT-1** The handler runs with a fake STS server and a mocked S3 client. The
  fake STS host is injected through the handler's constructor in tests only. No
  environment variable or production configuration can point the handler at a
  host other than `sts.<region>.amazonaws.com` (02, VAL-1).
- **IT-2** Concurrent `PUT`s of the same hash leave exactly one object and return
  `200` once, `409` for the rest (01, CON-3).

## 5. End-to-end tests (against an existing deployment)

- **E2E-1** Fixture Nx workspaces on Nx 21.0.0 and the latest Nx, each with the
  plugin installed:
  1. A build with an allowed role stores outputs.
  2. After clearing the local cache, the same build is a remote cache hit.
  3. A role that is not on the allowed list is refused (a miss and a skipped
     upload, D-34). The build still passes.
  4. One allowed role reads and writes two workspaces, and their artifacts stay
     under separate prefixes.
  5. An artifact over the size limit is not stored (`403`). The build still
     passes.
  6. With no AWS credentials, the plugin warns and the build passes on the
     local cache.
- **E2E-2** The suite runs against a deployment given by environment variables
  (URL, region, audience), with two AWS profiles: one for a listed role and one
  for an unlisted role. Nothing in this repository creates the deployment or the
  roles (D-30). Maintainers run it by hand before a release
  ([`e2e/README.md`](../../e2e/README.md)). The suite was also run against a
  local stand-in: the real handler behind an HTTP adapter that mimics API
  Gateway's limits and the size gate, with a fake STS and an in-memory S3.

## 6. Infrastructure tests

As in 06 section 6 (offline only: TF-11 and TF-12).

## 7. Coverage

- **COV-1** Coverage is judged by the requirement lists above, not by a
  percentage: every UT, CT, IT and E2E item has at least one test.
