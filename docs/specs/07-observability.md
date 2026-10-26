# 07 — Observability

| | |
|---|---|
| Status | Draft |
| Depends on | [03](./03-architecture-and-request-handling.md), [06](./06-terraform.md) |
| Decisions | D-26 (CloudWatch only; no X-Ray) |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Logs

- **LOG-1** The handler writes one structured JSON line per request, at level
  `INFO`. The function uses Lambda's JSON log format; the handler writes its
  lines straight to stdout, already JSON, so they are not wrapped, and each
  line also carries the request's EMF metrics (MET-1). A request the size gate
  denies is logged by the gate instead (03, APIGW-10).

  | Field | Notes |
  |---|---|
  | `requestId`, `apiRequestId` | Lambda and API Gateway request IDs |
  | `method`, `workspace`, `hash` | |
  | `outcome` | `hit`, `miss`, `stored`, `exists`, `oversize`, `bad_request`, `unauthenticated`, `forbidden`, `upstream_error`, `internal_error`, `disabled`. Also sent to the client in the `x-nx-cache-outcome` header (D-34). |
  | `status` | HTTP status returned |
  | `bytes` | Artifact size for `hit` and `stored` |
  | `durationMs`, `stsMs`, `s3Ms` | |
  | `principal`, `session` | Normalized identity (02, 5.1), when authenticated |
  | `tokenHash8` | First 8 hex characters of the token's SHA-256 (02, VAL-2) |
  | `authCache` | `hit` or `miss` (02, VAL-3) |
  | `sourceIp`, `userAgent` | From the API Gateway request context |
  | `errorCode`, `awsRequestId` | For `upstream_error`: S3 or STS error code and request ID |
| `upstream` | `sts` or `s3`, for `upstream_error` |
| `reason` | Why a request was rejected, in words |

- **LOG-2** Logs MUST NOT contain tokens, credentials, request bodies or
  response bodies.
- **LOG-3** Upstream failures are logged at `ERROR` with the error code and the
  AWS request ID. Validation and auth rejections stay at `INFO`.
- **LOG-4** The handler log group's retention is `log_retention_days`, which
  is at least `retention_days` (04, AUD-2). The access log group's retention is
  the same.

## 2. Metrics

Emitted by the handler in CloudWatch Embedded Metric Format. No extra API calls.

- **MET-1** Namespace `NxCache`, dimensions `Environment` and `Workspace`, plus
  `Environment` alone for totals. The `Workspace` dimension is only emitted once
  the caller is an allowed role. Workspace IDs are not registered (WS-2), so
  otherwise anyone could create metric series by inventing workspaces.

  | Metric | Unit | When |
  |---|---|---|
  | `CacheHit`, `CacheMiss` | Count | `GET` 200 / 404 |
  | `Stored`, `AlreadyExists` | Count | `PUT` 200 / 409 |
  | `RejectedOversize` | Count | `PUT` rejected as too large by the handler or the size gate |
  | `Unauthenticated`, `Forbidden` | Count | 401 / 403 |
  | `UpstreamError` | Count | STS or S3 failed, with an extra `Upstream` dimension (`sts` or `s3`) |
| `InternalError` | Count | The handler caught an unexpected error |
  | `ArtifactBytes` | Bytes | Size on `hit` and `stored`, and declared size on `oversize` |
  | `StsLatency`, `S3Latency` | Milliseconds | Per call |

- **MET-2** Log metric filters on the API Gateway access logs count responses
  that never reached the handler: `GatewayRejectedOversize` (body over the
  gateway limit, 03 SIZE-3), `GatewayThrottled` (`429`) and `Gateway5xx`, with
  an `Environment` dimension taken from the log line.
- **MET-3** Hit rate is `CacheHit / (CacheHit + CacheMiss)`, computed with
  metric math on the dashboard. It is not emitted.

## 3. Dashboard

One dashboard per instance, showing:

- requests by outcome, and hit rate overall and per workspace;
- artifact size p50, p95 and maximum, and oversize rejections (handler and
  gateway);
- latency p50 and p95 for API Gateway, Lambda duration, STS and S3;
- 4xx and 5xx counts, Lambda errors, throttles and concurrent executions.

## 4. Alarms

Alarms go to whoever deploys the instance (D-33). They notify one SNS topic:
either an existing topic the deployer passes in (`alarm_sns_topic_arn`), or a
topic the module creates with one email subscription per address in
`alarm_emails`. Each address must confirm the subscription email from AWS
before it receives alarms. Each alarm sends both an alarm and an OK
notification. Thresholds are Terraform inputs; the defaults are below.

| Alarm | Condition (default) |
|---|---|
| API 5xx rate | `5XXError / Count` > 5% for 3 of 3 five-minute periods, with at least 20 requests |
| Lambda errors | `Errors` > 0 in 2 consecutive five-minute periods (the handler returns 503 rather than throwing, so errors mean crashes) |
| Lambda throttles | `Throttles` > 0 in a five-minute period (reserved concurrency reached) |
| STS failures | `UpstreamError{Upstream=sts}` > 10 in five minutes |
| S3 failures | `UpstreamError{Upstream=s3}` > 10 in five minutes |
| Handler internal errors | `InternalError` > 0 in five minutes |
| Missing data | Missing data is treated as not breaching (quiet periods are normal) |

- **ALM-1** When `alarms_enabled = false` (for example, in a dev instance), the
  alarms are not created. The dashboard always is.
- **ALM-2** When alarms are enabled but neither `alarm_emails` nor
  `alarm_sns_topic_arn` is set, the alarms are created without notifications,
  and a Terraform `check` block warns at plan time that nobody will be told.
