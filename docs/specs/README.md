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
| D-10 | Artifact bytes pass through Lambda. No redirect to presigned S3 URLs. Size is capped by Lambda payload limits (see PC-2). | Q-4 |

## Spec index

| # | Document | Status |
|---|---|---|
| 01 | [Nx remote cache HTTP contract](./01-nx-remote-cache-contract.md) | Draft |
| 02 | [Authentication and authorization](./02-authentication-and-authorization.md) | Draft |
| — | [OpenAPI document (verbatim from Nx)](./nx-remote-cache.openapi.json) | Reference |

Planned: architecture and front door, storage and lifecycle, Lambda handlers,
client tooling (token CLI and Nx plugin), Terraform modules, observability,
testing, and the SPIKE-1 client spike.

## Constraints found in research

- **PC-1 Nx can only send a static bearer token.** The client cannot sign
  requests with SigV4, so API Gateway `AWS_IAM` authorization and Lambda function
  URLs with `AWS_IAM` auth cannot be used directly. Resolved by D-8.
- **PC-2 Lambda payload limits.** A synchronous Lambda invocation carries at most
  6 MB in its request and in its response. Binary bodies are base64-encoded
  inside the event and the response, which adds a third. **The effective cap on
  artifact size is therefore about 4.4 MB**, not 6 MB. API Gateway also caps
  payloads at 10 MB and integrations at about 30 seconds. See Q-4a.
- **PC-3 Cache poisoning (CREEP, CVE-2025-36852).** Nx deprecated its own
  bucket-based caches, `@nx/s3-cache` among them, on 2026-05-21, because one
  shared read-write credential lets an untrusted build write artifacts that a
  trusted build later restores. Accepted as risk R-1 under D-9 (see 02, section 6).
- **PC-4 Precedence.** Nx ignores the HTTP cache when Nx Cloud or any `@nx/*-cache`
  plugin is configured (01, CB-2).
- **PC-5 Token injection hook.** In `nx@24.0.1`, a plugin's `preTasksExecution`
  hook runs before any task runs. Environment variables it sets on `process.env`
  are copied into the main Nx process, and the remote cache client is created
  after that. A small Nx plugin could therefore mint the token on every run.
  See Q-14.

## Open questions (for the product owner)

| ID | Question | Status |
|---|---|---|
| Q-1 | Which clients use the cache? | Answered → D-7 |
| Q-2 | How should an IAM identity become the bearer token? | Answered → D-8 |
| Q-3 | Who may write to the cache? | Answered → D-9 |
| Q-4 | Largest artifact, and may bodies bypass Lambda? | Answered → D-10 |
| Q-4a | Is the effective cap of about 4.4 MB acceptable, and what should happen to larger artifacts? | Open |
| Q-5 | Is the endpoint public with a custom domain, or private inside a VPC? | Open |
| Q-6 | One Nx workspace or several? If several, is each one isolated? | Open |
| Q-7 | Retention: how long artifacts live, and any total size or cost cap? | Open |
| Q-8 | Encryption: SSE-S3 or SSE-KMS (customer-managed key)? | Open |
| Q-9 | AWS accounts, regions and environments (dev, prod); existing Terraform conventions such as state backend, module registry and tagging? | Open |
| Q-10 | Longest single Nx command in CI and locally (sets minimum token lifetime)? | Open |
| Q-11 | Nx versions in the consuming workspaces? | Open |
| Q-12 | Observability: logging, metrics (hit rate), tracing, alarms, and where they go? | Open |
| Q-13 | Repository tooling for this project: package manager, Node.js runtime, test framework, and how it is deployed (CI/CD)? | Open |
| Q-14 | Should tokens be minted automatically by an Nx plugin, by a CLI the user runs, or both? | Open |

Authentication-specific questions (AQ-1 to AQ-4) are tracked in
[02](./02-authentication-and-authorization.md#7-open-questions).
