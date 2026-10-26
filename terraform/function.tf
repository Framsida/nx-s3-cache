# The handler function (03 §4).

data "aws_iam_policy_document" "handler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "handler" {
  name               = local.function_name
  assume_role_policy = data.aws_iam_policy_document.handler_assume.json
  tags               = local.tags
}

# FN-6, and nothing more: no s3:DeleteObject and no STS permission.
data "aws_iam_policy_document" "handler" {
  statement {
    sid       = "ReadWriteArtifacts"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${local.bucket_arn}/v1/*"]
  }

  # Without it S3 answers 403 instead of 404 for a missing key (PC-6). It is
  # not narrowed with an s3:prefix condition: whether S3's implicit check for a
  # missing key honours one is undocumented, and if it did not, every miss
  # would look like an S3 failure. The handler never lists keys.
  statement {
    sid       = "MissingKeysAre404"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
  }

  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.handler.arn}:*"]
  }
}

resource "aws_iam_role_policy" "handler" {
  name   = "cache-access"
  role   = aws_iam_role.handler.id
  policy = data.aws_iam_policy_document.handler.json
}

resource "aws_cloudwatch_log_group" "handler" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_lambda_function" "handler" {
  function_name    = local.function_name
  description      = "Nx remote cache (nx-s3-serverless-cache), ${var.environment}"
  role             = aws_iam_role.handler.arn
  filename         = var.lambda_package_path
  source_code_hash = filebase64sha256(var.lambda_package_path)
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  memory_size      = var.lambda_memory_mb
  timeout          = var.lambda_timeout_seconds

  # -1 removes any reservation (FN-3).
  reserved_concurrent_executions = coalesce(var.lambda_reserved_concurrency, -1)

  environment {
    variables = local.lambda_environment
  }

  logging_config {
    log_format            = "JSON"
    log_group             = aws_cloudwatch_log_group.handler.name
    application_log_level = "INFO"
    system_log_level      = "WARN"
  }

  tags = local.tags

  lifecycle {
    precondition {
      condition     = local.lambda_environment_bytes <= 4096
      error_message = "The handler's environment variables total ${local.lambda_environment_bytes} bytes; Lambda allows 4096. Shorten allowed_role_arns (03, FN-5)."
    }
  }

  depends_on = [aws_iam_role_policy.handler]
}

# API Gateway may invoke the function for the cache route and as the PUT size
# gate (D-36).
resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGatewayRoute"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.handler.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.this.execution_arn}/*/*/*"
}

resource "aws_lambda_permission" "size_gate" {
  statement_id  = "AllowApiGatewaySizeGate"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.handler.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.this.execution_arn}/authorizers/*"
}
