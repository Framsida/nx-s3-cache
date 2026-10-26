# nx-s3-serverless-cache specifications

Specifications for a self-hosted Nx remote cache on AWS. Requests are handled by
AWS Lambda, artifacts are stored in Amazon S3, and callers authenticate with AWS
IAM. This repository ships the code, a Terraform module and an Nx plugin.
Deployers build and apply it from their own repositories. These documents are
what the implementation is built and tested against.

**Phase:** implementation. SPIKE-1 is done and its results are recorded below
and in 01, 03 and 05. The code, the Terraform module and the offline tests are
in place. SPIKE-2 and the end-to-end suite wait for a test deployment (step 6
of the build order).

## Decisions

Superseded decisions are kept, struck through, so the history stays readable.

| ID | Decision | Source |
|---|---|---|
| D-1 | Implement the Nx self-hosted remote cache OpenAPI contract ([01](./01-nx-remote-cache-contract.md)). | Brief |
| D-2 | Store artifacts in Amazon S3. | Brief |
| D-3 | Run request handling in AWS Lambda. | Brief |
| D-4 | Authenticate callers with AWS IAM. | Brief |
| D-5 | Write application code in TypeScript. | Brief |
| D-6 | Write infrastructure as code in Terraform. | Brief |
| D-7 | Clients are CI running inside AWS (instance or task roles) and developer machines (IAM Identity Center or AWS profiles). CI outside AWS is out of scope. | Q-1 |
| D-8 | Bearer token = presigned STS `GetCallerIdentity` request, validated by the server against STS ([02](./02-authentication-and-authorization.md)). | Q-2 |
| D-9 | Every allowed principal may read and write. Cache poisoning is an accepted risk (R-1 in 02), with required mitigations. | Q-3 |
| D-10 | Artifact bytes pass through Lambda. No redirect to presigned S3 URLs. | Q-4 |
| D-11 | ~~Allowed principals are account ID plus role-name pattern.~~ Superseded by D-27. | AQ-1 |
| D-12 | Uploads over the size limit get a ~~clear `413`~~ `403` with the reason (D-34, D-36) and a metric. Nx carries on without remote caching for that task. | Q-4a |
| D-13 | Public HTTPS endpoint on a custom domain. The token is the only gate. | Q-5 |
| D-14 | Tokens are minted automatically by an Nx plugin (`preTasksExecution`), with a matching CLI for scripts and debugging. | Q-14 |
| D-15 | Front door is an API Gateway REST API with a single Lambda that does authentication and cache logic. | Q-16 |
| D-16 | Several Nx workspaces share one deployment, each with its own key prefix. ~~Each with its own access rules~~ (access changed by D-27). | Q-6 |
| D-17 | Artifacts expire 14 days after upload. | Q-7 |
| D-18 | Encryption at rest with SSE-S3. | Q-8 |
| D-19 | No WAF. Abuse is contained by API Gateway throttling, optional Lambda reserved concurrency and early token rejection. | Q-15 |
| D-20 | The module supports several instances (for example dev and prod) in one account and region, separated by name prefix. | Q-9 |
| D-21 | The longest Nx command runs under 1 hour. Token lifetime defaults to 3600 s on both client and server. | Q-10 |
| D-22 | Consuming workspaces run Nx 21 or newer, with mixed versions. Support 21.0.0 as the floor and test the floor and the latest. | Q-11 |
| D-23 | This repo is a pnpm + Nx workspace, tested with Vitest and bundled with esbuild. The Lambda runtime is Node.js 24. | Q-13 |
| D-24 | ~~Terraform is applied manually from this repo.~~ Superseded by D-30. | Q-13 |
| D-25 | ~~Terraform state goes in an existing S3 backend configured in this repo.~~ Superseded by D-29. | Q-9b |
| D-26 | Observability is CloudWatch only: JSON logs, EMF metrics, a dashboard, alarms to SNS. No X-Ray. | Q-12 |
| D-27 | Access is one list of exact IAM role ARNs (`allowed_role_arns`), which may come from different accounts. Every listed role can read and write every workspace. No wildcards. Workspace IDs are not registered. | Q-20, Q-21 |
| D-28 | Region and domain are deployer inputs. The region comes from the deployer's AWS provider. The domain's Route 53 public hosted zone must already exist. | Q-9a |
| D-29 | The Terraform state bucket is the deployer's, passed at `terraform init` (partial backend configuration). | Q-9b |
| D-30 | This repo never runs Terraform against AWS. It ships the module and an example; deployers apply from their own repos. | Q-22 |
| D-31 | Deployers build the Lambda zip from source at a release tag. | Q-23 |
| D-32 | The client package (Nx plugin and CLI) is named `nx-s3-serverless-cache`. Registry decided later. | Q-17 |
| D-33 | Alarms go to whoever deploys the instance: email addresses (`alarm_emails`) or an existing SNS topic (`alarm_sns_topic_arn`). The deployer operates the instance. | Q-19 |
| D-34 | Nx fails the whole command on any `GET` status but `200` and `404`, and on any `PUT` status but `200`, `403` and `409` (PC-9). The handler therefore answers every request it cannot serve as a miss (`GET` → `404`, no body) or a skipped upload (`PUT` → `403`, `text/plain` reason), and reports the real outcome in the `x-nx-cache-outcome` header, the log line and the metrics. This replaces the `400`, `401`, `403` on `GET`, `411`, `413` and `503` responses of 01 CON-6 and 03 §5.4. | SPIKE-1 |
| D-35 | The kill switch is the `cache_enabled` input: every request becomes a miss or a skipped upload. Reserved concurrency `0` would fail every Nx command. | SPIKE-1 |
| D-36 | `PUT` passes a size gate: the same Lambda function runs as a `REQUEST` authorizer on `PUT` only and denies a declared `Content-Length` over the limit, before the body reaches Lambda's 6 MB event. API Gateway responses that only `PUT` can produce (authorizer and body-size errors) are `403`. Without this, outputs of about 4.5 MB or more fail the Nx command with a `5xx`. | SPIKE-1 |
| D-37 | Hash pattern `^[A-Za-z0-9]{1,128}$` (01, CON-2). Nx sends 1 to 20 decimal digits; letters keep custom task hashers working. | SPIKE-1 (CQ-6) |
| D-38 | URL-1 is used: the workspace is the first path segment, because Nx keeps the server URL's path (03, URL-2). | SPIKE-1 (CQ-3) |

## Spec index

| # | Document | Status |
|---|---|---|
| 01 | [Nx remote cache HTTP contract](./01-nx-remote-cache-contract.md) | Draft |
| 02 | [Authentication and authorization](./02-authentication-and-authorization.md) | Draft |
| 03 | [Architecture and request handling](./03-architecture-and-request-handling.md) | Draft |
| 04 | [Storage](./04-storage.md) | Draft |
| 05 | [Client tooling: Nx plugin and CLI](./05-client-tooling.md) | Draft |
| 06 | [Terraform module](./06-terraform.md) | Draft |
| 07 | [Observability](./07-observability.md) | Draft |
| 08 | [Testing and spikes](./08-testing-and-spikes.md) | Draft |
| 09 | [Operations (deployer guide)](./09-operations.md) | Draft |
| 10 | [Repository layout and delivery](./10-repository-and-delivery.md) | Draft |
| — | [OpenAPI document (verbatim from Nx)](./nx-remote-cache.openapi.json) | Reference |
| — | [SPIKE-1 results](../../tools/spike-stub-server/README.md) | Done |

### Suggested build order

Steps 1 to 5 are done. Step 6 is open.

1. SPIKE-1 (08): settles the URL layout, hash pattern and client error handling.
2. Repository scaffold (10) and `token-format`.
3. `cache-handler` (03, 04) with unit, contract and integration tests.
4. `nx-s3-serverless-cache` plugin and CLI (05).
5. Terraform module, example and offline tests (06, 07).
6. A maintainer deploys a test instance from outside this repo, then runs
   SPIKE-2 and the end-to-end suite (08).

## Constraints found in research

- **PC-1 Nx can only send a static bearer token.** The client cannot sign
  requests with SigV4, so API Gateway `AWS_IAM` authorization and Lambda function
  URLs with `AWS_IAM` auth cannot be used directly. Resolved by D-8.
- **PC-2 Lambda payload limits.** A synchronous Lambda invocation carries at most
  about 6 MB in its request and in its response. Binary bodies are
  base64-encoded inside the event and the response, which adds a third. The
  ceiling on artifact size is therefore about 4.5 MB. The default limit is
  4 MiB (03, SIZE-1).
- **PC-3 Cache poisoning (CREEP, CVE-2025-36852).** Nx deprecated its own
  bucket-based caches, `@nx/s3-cache` among them, on 2026-05-21, because one
  shared read-write credential lets an untrusted build write artifacts that a
  trusted build later restores. Accepted as risk R-1 under D-9 and D-27 (02,
  section 6).
- **PC-4 Precedence.** Nx ignores the HTTP cache when Nx Cloud or any `@nx/*-cache`
  plugin is configured (01, CB-2).
- **PC-5 Token injection hook.** From `nx@20.8.0` through at least `24.0.1`, a
  plugin's `preTasksExecution` hook runs before any task runs. Environment
  variables it sets on `process.env` are copied into the main Nx process, and the
  remote cache client is created after that. This enables D-14. Confirmed by
  SPIKE-1 on 21.0.0 and 24.0.1; see PC-11 for the daemon.
- **PC-6 Missing-key status.** Without `s3:ListBucket`, S3 `GetObject` returns
  `403` instead of `404` for a missing key. The handler role needs it (03, FN-6).
- **PC-7 API Gateway error bodies.** REST API built-in errors are JSON by
  default. They must be rewritten as plain text with gateway responses
  (03, APIGW-5).
- **PC-8 Role paths.** STS reports an assumed role's account and name, but not
  its IAM path. Allowed role ARNs are matched on account and name (02, AUTHZ-2).
- **PC-9 Nx fails commands on unexpected statuses** (SPIKE-1, CQ-5). Only `200`
  and `404` on `GET`, and `200`, `403` and `409` on `PUT`, let the command
  succeed. Every other status, a `200` whose body is not a tarball, and a
  refused connection fail it. Resolved by D-34 and D-36 where the handler or the
  gateway can choose; failures before the handler (throttling, a crashed
  Lambda, an outage) still fail Nx commands.
- **PC-10 No client timeout** (CQ-7). A request that is never answered waits
  indefinitely; API Gateway's 29 s integration timeout is what bounds it.
- **PC-11 Daemon environment** (CQ-8). With the daemon on, Nx before 22.7.0 runs
  `preTasksExecution` with the environment the daemon started with, and values
  the hook sets stay in the daemon between commands. From 22.7.0 the client's
  environment is forwarded. With the daemon on, the hook's output goes to the
  daemon log, not the terminal.

## Open questions

| ID | Question | Status |
|---|---|---|
| Q-1 to Q-16 | Clients, auth, writers, size, network, workspaces, retention, encryption, environments, run length, Nx versions, observability, tooling, token setup, WAF, front door | Answered (see decisions) |
| Q-17 | Which registry publishes `nx-s3-serverless-cache`? | Name answered → D-32. Registry deferred. |
| Q-18 | CI platform for this repo's offline checks | Assumed GitHub Actions ([workflow](../../.github/workflows/ci.yml)); confirm |
| Q-19 | Alarm recipients and operations owner | Answered → D-33 |
| Q-20 | Do allowed roles apply per workspace or to the whole cache? | Answered → D-27 |
| Q-21 | Role identifier format | Answered → D-27 (exact ARNs) |
| Q-22 | Where does Terraform run? | Answered → D-30 |
| Q-23 | How do deployers get the Lambda code? | Answered → D-31 |

Authentication questions (AQ-1 to AQ-4) are all answered; see
[02](./02-authentication-and-authorization.md#7-questions). Client behaviour
questions (CQ-1 to CQ-10) were answered by SPIKE-1 (01 §5, 05 §6).
