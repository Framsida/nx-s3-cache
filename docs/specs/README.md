# nx-s3-cache specifications

Specifications for a self-hosted Nx remote cache on AWS. Requests are handled by
AWS Lambda, artifacts are stored in Amazon S3, and callers authenticate with AWS
IAM. These documents are what the implementation is built and tested against.

**Phase:** discovery and planning. No implementation code yet.

## Fixed by the brief

| ID | Decision |
|---|---|
| D-1 | Implement the Nx self-hosted remote cache OpenAPI contract ([01](./01-nx-remote-cache-contract.md)). |
| D-2 | Store artifacts in Amazon S3. |
| D-3 | Run request handling in AWS Lambda. |
| D-4 | Authenticate callers with AWS IAM. |
| D-5 | Write application code in TypeScript. |
| D-6 | Write infrastructure as code in Terraform. |

## Spec index

| # | Document | Status |
|---|---|---|
| 01 | [Nx remote cache HTTP contract](./01-nx-remote-cache-contract.md) | Draft |
| — | [OpenAPI document (verbatim from Nx)](./nx-remote-cache.openapi.json) | Reference |

Planned once the open questions below are answered: architecture, authentication
and authorization, storage and lifecycle, Terraform modules, Lambda handlers,
client tooling, observability, testing and the SPIKE-1 client spike.

## Constraints found in research

- **PC-1 Nx can only send a static bearer token.** The client sends
  `Authorization: Bearer $NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` and cannot
  sign requests with SigV4. So the AWS-native IAM front doors (API Gateway
  `AWS_IAM` authorization, Lambda function URLs with `AWS_IAM` auth) cannot be
  used directly. The design needs a bridge that turns an IAM identity into a
  bearer token, or a local signing proxy.
- **PC-2 Lambda payload limits.** A synchronous Lambda invocation carries at most
  6 MB in its request and its response. API Gateway adds a 10 MB payload limit
  and a timeout of about 30 seconds. Nx artifacts (bundles, coverage, test
  output) are often larger. Bodies should probably bypass Lambda via presigned
  S3 URLs, which depends on client redirect behaviour (CQ-2 in 01).
- **PC-3 Cache poisoning (CREEP, CVE-2025-36852).** Nx deprecated its own
  bucket-based caches, `@nx/s3-cache` among them, on 2026-05-21. The flaw is a
  design flaw: one credential with read-write access to the whole cache, and no
  record of which branch produced an artifact. A pull-request run can write a
  poisoned artifact under a hash that a later `main` run restores. Our design
  MUST state who may write, and from which context.
- **PC-4 Precedence.** Nx ignores the HTTP cache when Nx Cloud or any `@nx/*-cache`
  plugin is configured (01, CB-2).

## Open questions (for the product owner)

| ID | Question | Status |
|---|---|---|
| Q-1 | Which clients use the cache: which CI systems, and developer machines? | Open |
| Q-2 | How should an IAM identity become the bearer token Nx sends? | Open |
| Q-3 | Who may write to the cache, and from which branches or contexts? | Open |
| Q-4 | Largest expected artifact, and may bodies bypass Lambda via presigned S3? | Open |
| Q-5 | Is the endpoint public with a custom domain, or private inside a VPC? | Open |
| Q-6 | One Nx workspace or several? If several, is each one isolated? | Open |
| Q-7 | Retention: how long artifacts live, and any total size or cost cap? | Open |
| Q-8 | Encryption: SSE-S3 or SSE-KMS (customer-managed key)? | Open |
| Q-9 | AWS accounts, regions and environments (dev, prod); existing Terraform conventions such as state backend, module registry and tagging? | Open |
| Q-10 | Longest single Nx command in CI and locally (sets minimum token lifetime)? | Open |
| Q-11 | Nx versions in the consuming workspaces? | Open |
| Q-12 | Observability: logging, metrics (hit rate), tracing, alarms, and where they go? | Open |
| Q-13 | Repository tooling for this project: package manager, Node.js runtime, test framework, and how it is deployed (CI/CD)? | Open |
