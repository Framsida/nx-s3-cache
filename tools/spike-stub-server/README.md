# SPIKE-1: Nx client behaviour

Throwaway tooling for SPIKE-1 ([08 §1](../../docs/specs/08-testing-and-spikes.md)).
A stub HTTP server logs every request and plays scripted responses. Real Nx
workspaces run against it.

```
node tools/spike-stub-server/src/server.ts            # PORT, LABEL, LOG_FILE
tools/spike-stub-server/run-spike.sh <work dir> 21.0.0 24.0.1
```

`run-spike.sh` copies [`fixture/`](./fixture) into the work directory once per
Nx version, installs that version, and prints one line per experiment. The
fixture has one cacheable target and a local plugin whose `preTasksExecution`
hook sets the Nx variables from `SPIKE_*` variables. Raw output from the run on
2026-10-26 (Node.js 24.22.1, Linux x64) is in [`results/`](./results).

## Results

Both versions behaved the same everywhere except CQ-8.

| Question              | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CQ-1 `401` on `GET`   | Handled: Nx prints `Unauthorized: <body>` and **the command fails** (exit 1). Same for `PUT`.                                                                                                                                                                                                                                                                                                                                                                         |
| CQ-2 redirects        | `307` and `308` are followed for `GET` and `PUT`. The `PUT` body is re-sent. `Authorization` is kept on a same-origin redirect and dropped on a cross-origin one. Confirms CB-4.                                                                                                                                                                                                                                                                                      |
| CQ-3 path prefix      | Kept: `…/workspace-a` gives `/workspace-a/v1/cache/<hash>`. URL-1 works. A trailing slash gives `//v1`, so the plugin strips it.                                                                                                                                                                                                                                                                                                                                      |
| CQ-4 token reads      | Once per command. A token changed in the process 1.5 s into a run was not used by requests made 3 s later.                                                                                                                                                                                                                                                                                                                                                            |
| CQ-5 statuses         | `GET`: only `200` and `404` let the command succeed. `PUT`: only `200`, `403` and `409`. Everything else (`400`, `401`, `403` on `GET`, `404` on `PUT`, `411`, `413`, `429`, `5xx`, `2xx` other than `200`), a `200` with a body that is not a tarball, and a refused connection, **fail the command** with `Misconfigured remote cache endpoint: Unexpected response status: …`. A `PUT` `403` is silent: its body is not shown, even with `NX_VERBOSE_LOGGING`.     |
| CQ-6 hashes           | Decimal strings of 1 to 20 digits (u64), for example `8485680016397879100`, `18245694509759097932`, `146863263245050714`. Bodies are gzip (`1f8b08…`). `GET` carries `Content-Type: application/octet-stream` and no body.                                                                                                                                                                                                                                            |
| CQ-7 timeouts         | None found. A `GET` answered after 35 s succeeded; one never answered was still waiting after 280 s. The server side (API Gateway's 29 s integration timeout) is what bounds a request.                                                                                                                                                                                                                                                                               |
| CQ-8 hook environment | Without the daemon, the hook sees the invoking shell's environment, with or without plugin isolation. **With the daemon on, Nx 21.0.0 runs the hook with the environment the daemon was started with**; the shell's `AWS_PROFILE` and other variables are ignored. Nx 24.0.1 forwards the client's environment to the daemon and its plugin workers. The forwarding first appears in **Nx 22.7.0** (`applyDaemonEnvFromClient` and `setWorkerEnv`, absent in 22.6.0). |
| CQ-9 empty server     | Setting `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` to `''` from the hook turns the HTTP cache off, daemon on or off (`getHttpCache` tests the value for truthiness).                                                                                                                                                                                                                                                                                                        |
| CQ-10 / PC-5          | A token and server set by the hook reach the Rust client in every mode on both versions (on 21.0.0 with the daemon, from the daemon's environment as in CQ-8).                                                                                                                                                                                                                                                                                                        |

## Consequences for the design

Recorded as D-34 and D-35 in the [specs README](../../docs/specs/README.md).

- The handler never answers with a status that fails the command when it can
  avoid it. A request it cannot serve becomes a miss (`GET` → `404`) or a
  skipped upload (`PUT` → `403`). The real outcome is in the
  `x-nx-cache-outcome` header, the log line and the metrics.
- Failures the handler never sees (throttling, a crashed or timed-out Lambda,
  an outage, a body too large for Lambda) still fail Nx commands. No single
  status is safe for both methods, so API Gateway's responses cannot fix this.
- The kill switch is `cache_enabled = false` (the handler answers every request
  as a miss or a skipped upload). Reserved concurrency `0` would fail every
  command.
- On Nx before 22.7.0 with the daemon, the plugin sees the daemon's start-time
  environment. Set `profile` in the plugin options, or restart the daemon after
  changing AWS variables in the shell.
