# API Gateway REST API (03 §3).

locals {
  stage_name = "live"

  integration = {
    type                = "aws_proxy"
    httpMethod          = "POST"
    uri                 = aws_lambda_function.handler.invoke_arn
    passthroughBehavior = "when_no_match"
    timeoutInMillis     = 29000
  }

  # APIGW-3: one resource with GET and PUT. Authentication happens in the
  # handler, so errors are plain text. PUT also passes the size gate (D-36).
  openapi = {
    openapi = "3.0.1"
    info    = { title = local.name, version = "1" }
    paths = {
      "/{workspace}/v1/cache/{hash}" = {
        parameters = [
          { name = "workspace", in = "path", required = true, schema = { type = "string" } },
          { name = "hash", in = "path", required = true, schema = { type = "string" } },
        ]
        get = {
          "x-amazon-apigateway-integration" = local.integration
        }
        put = {
          security                          = [{ "size-gate" = [] }]
          "x-amazon-apigateway-integration" = local.integration
        }
      }
    }
    components = {
      securitySchemes = {
        "size-gate" = {
          type                           = "apiKey"
          name                           = "Content-Length"
          in                             = "header"
          "x-amazon-apigateway-authtype" = "custom"
          "x-amazon-apigateway-authorizer" = {
            type                         = "request"
            authorizerUri                = aws_lambda_function.handler.invoke_arn
            identitySource               = "method.request.header.Content-Length"
            authorizerResultTtlInSeconds = 0
          }
        }
      }
    }
    # Kept in the body: re-importing the body in overwrite mode would delete
    # gateway responses managed as separate resources.
    # The DEFAULT_ types keep the status of the error they stand for.
    "x-amazon-apigateway-gateway-responses" = merge(
      { for type, r in local.gateway_response_bodies : type => merge(r, { statusCode = tonumber(local.gateway_responses[type].status) }) if local.gateway_responses[type].status != null },
      { for type, r in local.gateway_response_bodies : type => r if local.gateway_responses[type].status == null },
    )
  }

  gateway_response_bodies = {
    for type, r in local.gateway_responses : type => {
      responseParameters = { "gatewayresponse.header.Content-Type" = "'text/plain'" }
      # Templates are picked by content type; Nx sends application/octet-stream,
      # so every type gets the same message.
      responseTemplates = {
        "application/json"         = r.message
        "application/octet-stream" = r.message
        "text/plain"               = r.message
      }
    }
  }

  # APIGW-5, with statuses from D-34 and D-36. Nx fails the command on any
  # status but 200 and 404 for GET, and 200, 403 and 409 for PUT. Responses
  # that only PUT can trigger (the body limit and the size gate, which is on
  # PUT only) are therefore 403: Nx skips that upload and carries on. The
  # others can happen on GET too, so no status is safe for both methods.
  gateway_responses = {
    MISSING_AUTHENTICATION_TOKEN   = { status = "404", message = "Not found" }
    REQUEST_TOO_LARGE              = { status = "403", message = "Nx cache: task output is too large for the Nx cache. It was not cached remotely." }
    ACCESS_DENIED                  = { status = "403", message = "Nx cache: task output is too large for the Nx cache. It was not cached remotely." }
    UNAUTHORIZED                   = { status = "403", message = "Content-Length is required" }
    AUTHORIZER_FAILURE             = { status = "403", message = "Nx cache is temporarily unavailable" }
    AUTHORIZER_CONFIGURATION_ERROR = { status = "403", message = "Nx cache is temporarily unavailable" }
    THROTTLED                      = { status = "429", message = "Nx cache is rate limiting requests; retry later" }
    INTEGRATION_TIMEOUT            = { status = "504", message = "Nx cache timed out" }
    DEFAULT_5XX                    = { status = null, message = "Nx cache is unavailable" }
    DEFAULT_4XX                    = { status = null, message = "Request rejected by the Nx cache" }
  }

  # APIGW-7. The environment is a constant so metric filters can use it as a
  # dimension. status is a number for the metric filters.
  access_log_format = jsonencode({
    environment        = var.environment
    requestId          = "$context.requestId"
    sourceIp           = "$context.identity.sourceIp"
    requestTime        = "$context.requestTime"
    httpMethod         = "$context.httpMethod"
    resourcePath       = "$context.resourcePath"
    status             = "$context.status"
    responseLength     = "$context.responseLength"
    responseType       = "$context.error.responseType"
    integrationLatency = "$context.integrationLatency"
    integrationStatus  = "$context.integrationStatus"
    userAgent          = "$context.identity.userAgent"
  })
}

resource "aws_api_gateway_rest_api" "this" {
  name = local.name
  body = jsonencode(local.openapi)

  # APIGW-4: bodies reach Lambda as base64 and base64 responses go out as bytes.
  binary_media_types = ["*/*"]
  # APIGW-1: the custom domain is the only way in.
  disable_execute_api_endpoint = true

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = local.tags
}

# TF-9: a new deployment whenever the body changes. It holds the routes, the
# integration, the size gate and the gateway responses.
resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id

  triggers = {
    redeployment = sha1(aws_api_gateway_rest_api.this.body)
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${local.name}-access"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_api_gateway_stage" "this" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  deployment_id = aws_api_gateway_deployment.this.id
  stage_name    = local.stage_name

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format          = replace(local.access_log_format, "\"$context.status\"", "$context.status")
  }

  tags = local.tags

  depends_on = [aws_api_gateway_account.this]
}

resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  stage_name  = aws_api_gateway_stage.this.stage_name
  method_path = "*/*"

  settings {
    metrics_enabled        = true
    throttling_rate_limit  = var.api_throttle_rate_limit
    throttling_burst_limit = var.api_throttle_burst_limit
    # APIGW-8: execution logs with request data would hold bearer tokens.
    logging_level      = "OFF"
    data_trace_enabled = false
  }
}

# TF-10: one setting per account and region, shared with everything else.
data "aws_iam_policy_document" "api_gateway_assume" {
  count = var.manage_api_gateway_account ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_gateway_logs" {
  count = var.manage_api_gateway_account ? 1 : 0

  name               = "${local.name}-apigateway-logs"
  assume_role_policy = data.aws_iam_policy_document.api_gateway_assume[0].json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "api_gateway_logs" {
  count = var.manage_api_gateway_account ? 1 : 0

  role       = aws_iam_role.api_gateway_logs[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "this" {
  count = var.manage_api_gateway_account ? 1 : 0

  cloudwatch_role_arn = aws_iam_role.api_gateway_logs[0].arn

  depends_on = [aws_iam_role_policy_attachment.api_gateway_logs]
}
