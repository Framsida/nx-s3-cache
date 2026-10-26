# End-to-end suite

Runs against an existing deployment (08, E2E-2). Nothing in this repository
creates the deployment or the roles. Maintainers run it by hand before a
release. Without `E2E_URL` every test is skipped.

| Variable                 | Required | Meaning                                                  |
| ------------------------ | -------- | -------------------------------------------------------- |
| `E2E_URL`                | yes      | Cache base URL, e.g. `https://nx-cache-test.example.com` |
| `E2E_REGION`             | yes      | Deployment region                                        |
| `E2E_ALLOWED_PROFILE`    | yes      | AWS profile for a role on `allowed_role_arns`            |
| `E2E_UNLISTED_PROFILE`   | yes      | AWS profile for a role that is not                       |
| `E2E_AUDIENCE`           | no       | Token audience, if it is not the URL's host              |
| `E2E_MAX_ARTIFACT_BYTES` | no       | The deployment's `max_artifact_bytes` (default 4194304)  |
| `E2E_NX_VERSIONS`        | no       | Comma-separated, default `21.0.0,latest`                 |

```sh
aws sso login --profile nx-cache-allowed
E2E_URL=https://nx-cache-test.example.com E2E_REGION=eu-west-1 \
E2E_ALLOWED_PROFILE=nx-cache-allowed E2E_UNLISTED_PROFILE=nx-cache-unlisted \
  pnpm nx run e2e:e2e
```

- [`suites/cache.e2e.test.ts`](./suites/cache.e2e.test.ts): E2E-1. Fixture
  workspaces on each Nx version, with the plugin installed from a packed
  tarball: store, remote hit, unlisted role, two workspaces, oversize output,
  no credentials.
- [`suites/deployment.e2e.test.ts`](./suites/deployment.e2e.test.ts): the
  SPIKE-2 checks. Byte-for-byte round trips, gateway responses, the size gate
  and API Gateway's body limit.

Some SPIKE-2 items need eyes on the AWS console rather than a test. After a run,
check that the handler's log lines in CloudWatch are top-level JSON (not
wrapped in `message`), and that the `NxCache` metrics appear (SP2-5).
