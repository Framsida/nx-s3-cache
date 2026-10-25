# nx-s3-cache specifications

Specifications for a self-hosted Nx remote cache on AWS. Requests are handled by
AWS Lambda, artifacts are stored in Amazon S3, and callers authenticate with AWS
IAM. These documents are what the implementation is built and tested against.

**Phase:** discovery and planning. No implementation code yet.

## Decisions

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
| D-11 | Allowed principals are named roles: account ID plus role-name pattern. IAM users, root and federated users are never allowed. | AQ-1, AQ-3 |
| D-12 | Uploads over the size limit get a clear `413` and a metric. Nx carries on without remote caching for that task. | Q-4a |
| D-13 | Public HTTPS endpoint on a custom domain. The token is the only gate. | Q-5 |
| D-14 | Tokens are minted automatically by an Nx plugin (`preTasksExecution`), with a matching CLI for scripts and debugging. | Q-14 |
| D-15 | Front door is an API Gateway REST API with a single Lambda that does authentication and cache logic. | Q-16 |
| D-16 | Several Nx workspaces, each isolated with its own key prefix and its own access rules. | Q-6 |
| D-17 | Artifacts expire 14 days after upload. | Q-7 |
| D-18 | Encryption at rest with SSE-S3. | Q-8 |

## Spec index

| # | Document | Status |
|---|---|---|
| 01 | [Nx remote cache HTTP contract](./01-nx-remote-cache-contract.md) | Draft |
| 02 | [Authentication and authorization](./02-authentication-and-authorization.md) | Draft |
| 03 | [Architecture and request handling](./03-architecture-and-request-handling.md) | Draft |
| 04 | [Storage](./04-storage.md) | Draft |
| — | [OpenAPI document (verbatim from Nx)](./nx-remote-cache.openapi.json) | Reference |

Planned: 05 client tooling (Nx plugin and token CLI), 06 Terraform modules and
environments, 07 observability, 08 testing and spikes (SPIKE-1, SPIKE-2),
09 operations (purge, rotation, runbooks).

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
  trusted build later restores. Accepted as risk R-1 under D-9 (02, section 6).
- **PC-4 Precedence.** Nx ignores the HTTP cache when Nx Cloud or any `@nx/*-cache`
  plugin is configured (01, CB-2).
- **PC-5 Token injection hook.** In `nx@24.0.1`, a plugin's `preTasksExecution`
  hook runs before any task runs. Environment variables it sets on `process.env`
  are copied into the main Nx process, and the remote cache client is created
  after that. This enables D-14. To be confirmed by SPIKE-1.
- **PC-6 Missing-key status.** Without `s3:ListBucket`, S3 `GetObject` returns
  `403` instead of `404` for a missing key. The handler role needs it (03, FN-6).
- **PC-7 API Gateway error bodies.** REST API built-in errors are JSON by
  default. They must be rewritten as plain text with gateway responses
  (03, APIGW-5).

## Open questions (for the product owner)

| ID | Question | Status |
|---|---|---|
| Q-1 | Which clients use the cache? | Answered → D-7 |
| Q-2 | How should an IAM identity become the bearer token? | Answered → D-8 |
| Q-3 | Who may write to the cache? | Answered → D-9 |
| Q-4 | Largest artifact, and may bodies bypass Lambda? | Answered → D-10 |
| Q-4a | What happens to artifacts over the size limit? | Answered → D-12 |
| Q-5 | Public endpoint or private inside a VPC? | Answered → D-13 |
| Q-6 | One Nx workspace or several? | Answered → D-16 |
| Q-7 | Retention period? | Answered → D-17 |
| Q-8 | Encryption at rest? | Answered → D-18 |
| Q-9 | AWS accounts, regions and environments; DNS zone and domain; existing Terraform conventions (state backend, module layout, tagging)? | Open |
| Q-10 | Longest single Nx command in CI and locally (sets minimum token lifetime)? | Open |
| Q-11 | Nx versions in the consuming workspaces? | Open |
| Q-12 | Observability: logging, metrics (hit rate), tracing, alarms, and where they go? | Open |
| Q-13 | Repository tooling for this project: package manager, Node.js runtime, test framework, and how it is deployed (CI/CD)? | Open |
| Q-14 | How do tokens get into the Nx environment? | Answered → D-14 |
| Q-15 | Is a WAF web ACL attached to the REST API? If so, which rules? | Open |
| Q-16 | What sits in front of the Lambda? | Answered → D-15 |

Authentication-specific questions (AQ-1 to AQ-4) are tracked in
[02](./02-authentication-and-authorization.md#7-open-questions).
