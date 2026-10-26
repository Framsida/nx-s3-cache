# Metrics, alarms and the dashboard (07).

locals {
  api_dimensions    = { ApiName = aws_api_gateway_rest_api.this.name, Stage = local.stage_name }
  lambda_dimensions = { FunctionName = aws_lambda_function.handler.function_name }

  create_topic    = var.alarms_enabled && var.alarm_sns_topic_arn == null && length(var.alarm_emails) > 0
  alarm_topic_arn = var.alarm_sns_topic_arn != null ? var.alarm_sns_topic_arn : (local.create_topic ? aws_sns_topic.alarms[0].arn : null)
  alarm_actions   = local.alarm_topic_arn == null ? [] : [local.alarm_topic_arn]

  # MET-2: requests API Gateway answered without the handler (03, SIZE-3).
  gateway_metric_filters = {
    GatewayRejectedOversize = "{ $.responseType = \"REQUEST_TOO_LARGE\" }"
    GatewayThrottled        = "{ $.status = 429 }"
    Gateway5xx              = "{ $.status >= 500 }"
  }
}

resource "aws_cloudwatch_log_metric_filter" "gateway" {
  for_each = local.gateway_metric_filters

  name           = "${local.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.access.name
  pattern        = each.value

  metric_transformation {
    name       = each.key
    namespace  = "NxCache"
    value      = "1"
    unit       = "Count"
    dimensions = { Environment = "$.environment" }
  }
}

# 07 section 4: an existing topic, or one created here for alarm_emails.
resource "aws_sns_topic" "alarms" {
  count = local.create_topic ? 1 : 0

  name = "${local.name}-alarms"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "email" {
  for_each = local.create_topic ? toset(var.alarm_emails) : toset([])

  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = each.value
}

# ALM-2: warn at plan time when nobody would be told.
check "alarm_recipients" {
  assert {
    condition     = !var.alarms_enabled || var.alarm_sns_topic_arn != null || length(var.alarm_emails) > 0
    error_message = "Alarms are enabled but have no recipients. Set alarm_emails or alarm_sns_topic_arn, or nobody will be told when the cache fails."
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx_rate" {
  count = var.alarms_enabled ? 1 : 0

  alarm_name          = "${local.name}-api-5xx-rate"
  alarm_description   = "More than ${var.alarm_thresholds.api_5xx_rate_percent}% of requests failed with a 5xx for 15 minutes. These fail Nx commands. Check the dashboard, the handler's ERROR logs and AWS Health."
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_thresholds.api_5xx_rate_percent
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = local.tags

  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApiGateway"
      metric_name = "5XXError"
      dimensions  = local.api_dimensions
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApiGateway"
      metric_name = "Count"
      dimensions  = local.api_dimensions
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "rate"
    expression  = "IF(requests >= ${var.alarm_thresholds.api_5xx_min_requests}, 100 * errors / requests, 0)"
    label       = "5xx rate (%)"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  count = var.alarms_enabled ? 1 : 0

  alarm_name          = "${local.name}-lambda-errors"
  alarm_description   = "The handler crashed or timed out in two consecutive 5-minute periods. It answers failures itself, so errors mean crashes, timeouts or a bad cold start."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = local.lambda_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  count = var.alarms_enabled ? 1 : 0

  alarm_name          = "${local.name}-lambda-throttles"
  alarm_description   = "The handler was throttled (reserved concurrency or the account limit was reached). Throttled requests fail Nx commands."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = local.lambda_dimensions
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "upstream" {
  for_each = var.alarms_enabled ? { sts = var.alarm_thresholds.sts_failures, s3 = var.alarm_thresholds.s3_failures } : {}

  alarm_name          = "${local.name}-${each.key}-failures"
  alarm_description   = "More than ${each.value} ${upper(each.key)} failures in 5 minutes. Those requests became cache misses or skipped uploads. Check the handler's ERROR logs (errorCode, awsRequestId) and AWS Health."
  namespace           = "NxCache"
  metric_name         = "UpstreamError"
  dimensions          = { Environment = var.environment, Upstream = each.key }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "internal_errors" {
  count = var.alarms_enabled ? 1 : 0

  alarm_name          = "${local.name}-internal-errors"
  alarm_description   = "The handler hit an unexpected error. The requests became misses or skipped uploads. Search the handler logs for outcome internal_error."
  namespace           = "NxCache"
  metric_name         = "InternalError"
  dimensions          = { Environment = var.environment }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = local.tags
}

# 07 section 3.
locals {
  env_metric = ["Environment", var.environment]
  api_metric = ["ApiName", aws_api_gateway_rest_api.this.name, "Stage", local.stage_name]
  fn_metric  = ["FunctionName", aws_lambda_function.handler.function_name]

  widget_defaults = { view = "timeSeries", region = local.region, period = 300 }

  dashboard_widgets = [
    {
      type = "metric", x = 0, y = 0, width = 12, height = 6
      properties = merge(local.widget_defaults, {
        title   = "Requests by outcome"
        stat    = "Sum"
        stacked = true
        metrics = [
          for m in ["CacheHit", "CacheMiss", "Stored", "AlreadyExists", "RejectedOversize", "Unauthenticated", "Forbidden", "InternalError"] :
          concat(["NxCache", m], local.env_metric)
        ]
      })
    },
    {
      type = "metric", x = 12, y = 0, width = 12, height = 6
      properties = merge(local.widget_defaults, {
        title = "Hit rate (%)"
        yAxis = { left = { min = 0, max = 100 } }
        metrics = [
          concat(["NxCache", "CacheHit"], local.env_metric, [{ id = "hit", stat = "Sum", visible = false }]),
          concat(["NxCache", "CacheMiss"], local.env_metric, [{ id = "miss", stat = "Sum", visible = false }]),
          [{ expression = "100 * hit / (hit + miss)", label = "All workspaces", id = "rate" }],
        ]
      })
    },
    {
      type = "metric", x = 0, y = 6, width = 12, height = 6
      properties = merge(local.widget_defaults, {
        title = "Hits and misses per workspace"
        metrics = [
          [{ expression = "SEARCH('{NxCache,Environment,Workspace} MetricName=\"CacheHit\" Environment=\"${var.environment}\"', 'Sum', 300)", label = "hits", id = "hits" }],
          [{ expression = "SEARCH('{NxCache,Environment,Workspace} MetricName=\"CacheMiss\" Environment=\"${var.environment}\"', 'Sum', 300)", label = "misses", id = "misses" }],
        ]
      })
    },
    {
      type = "metric", x = 12, y = 6, width = 12, height = 6
      properties = merge(local.widget_defaults, {
        title = "Artifact size and oversize rejections"
        metrics = [
          concat(["NxCache", "ArtifactBytes"], local.env_metric, [{ stat = "p50", label = "size p50" }]),
          concat(["NxCache", "ArtifactBytes"], local.env_metric, [{ stat = "p95", label = "size p95" }]),
          concat(["NxCache", "ArtifactBytes"], local.env_metric, [{ stat = "Maximum", label = "size max" }]),
          concat(["NxCache", "RejectedOversize"], local.env_metric, [{ stat = "Sum", label = "oversize (handler and size gate)", yAxis = "right" }]),
          concat(["NxCache", "GatewayRejectedOversize"], local.env_metric, [{ stat = "Sum", label = "oversize (gateway body limit)", yAxis = "right" }]),
        ]
      })
    },
    {
      type = "metric", x = 0, y = 12, width = 12, height = 6
      properties = merge(local.widget_defaults, {
        title = "Latency (ms)"
        metrics = [
          concat(["AWS/ApiGateway", "Latency"], local.api_metric, [{ stat = "p50", label = "API p50" }]),
          concat(["AWS/ApiGateway", "Latency"], local.api_metric, [{ stat = "p95", label = "API p95" }]),
          concat(["AWS/Lambda", "Duration"], local.fn_metric, [{ stat = "p50", label = "Lambda p50" }]),
          concat(["AWS/Lambda", "Duration"], local.fn_metric, [{ stat = "p95", label = "Lambda p95" }]),
          concat(["NxCache", "StsLatency"], local.env_metric, [{ stat = "p50", label = "STS p50" }]),
          concat(["NxCache", "StsLatency"], local.env_metric, [{ stat = "p95", label = "STS p95" }]),
          concat(["NxCache", "S3Latency"], local.env_metric, [{ stat = "p50", label = "S3 p50" }]),
          concat(["NxCache", "S3Latency"], local.env_metric, [{ stat = "p95", label = "S3 p95" }]),
        ]
      })
    },
    {
      type = "metric", x = 12, y = 12, width = 12, height = 6
      properties = merge(local.widget_defaults, {
        title = "Errors, throttles and concurrency"
        stat  = "Sum"
        metrics = [
          concat(["AWS/ApiGateway", "4XXError"], local.api_metric, [{ label = "API 4xx" }]),
          concat(["AWS/ApiGateway", "5XXError"], local.api_metric, [{ label = "API 5xx" }]),
          concat(["NxCache", "GatewayThrottled"], local.env_metric, [{ label = "API throttled" }]),
          concat(["AWS/Lambda", "Errors"], local.fn_metric, [{ label = "Lambda errors" }]),
          concat(["AWS/Lambda", "Throttles"], local.fn_metric, [{ label = "Lambda throttles" }]),
          concat(["NxCache", "UpstreamError"], local.env_metric, ["Upstream", "sts", { label = "STS failures" }]),
          concat(["NxCache", "UpstreamError"], local.env_metric, ["Upstream", "s3", { label = "S3 failures" }]),
          concat(["AWS/Lambda", "ConcurrentExecutions"], local.fn_metric, [{ stat = "Maximum", label = "Lambda concurrency", yAxis = "right" }]),
        ]
      })
    },
  ]
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = local.name
  dashboard_body = jsonencode({ widgets = local.dashboard_widgets })
}
