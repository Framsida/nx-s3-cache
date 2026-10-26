# TF-12: input validations (06 §2) and the preconditions in TF-4 and TF-8,
# against a mocked AWS provider. Needs no credentials and creates nothing.

mock_provider "aws" {
  # Mocked computed values (ARNs, IDs) are known at plan time.
  override_during = plan

  mock_data "aws_region" {
    defaults = { region = "eu-west-1", name = "eu-west-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111", arn = "arn:aws:iam::111111111111:root", user_id = "111111111111" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_route53_zone" {
    defaults = { name = "example.com", zone_id = "Z0000000000EXAMPLE" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/nx-cache-test-handler" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:eu-west-1:111111111111:log-group:test" }
  }
  mock_resource "aws_lambda_function" {
    defaults = {
      arn        = "arn:aws:lambda:eu-west-1:111111111111:function:nx-cache-test-handler"
      invoke_arn = "arn:aws:apigateway:eu-west-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-west-1:111111111111:function:nx-cache-test-handler/invocations"
    }
  }
  mock_resource "aws_api_gateway_rest_api" {
    defaults = { id = "abc123", execution_arn = "arn:aws:execute-api:eu-west-1:111111111111:abc123" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:eu-west-1:111111111111:certificate/test"
      domain_validation_options = [{
        domain_name           = "nx-cache.example.com"
        resource_record_name  = "_abc.nx-cache.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_def.acm-validations.aws."
      }]
    }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:eu-west-1:111111111111:nx-cache-test-alarms" }
  }
}

variables {
  environment         = "test"
  domain_name         = "nx-cache.example.com"
  hosted_zone_name    = "example.com"
  lambda_package_path = "tests/fixtures/lambda.zip"
  allowed_role_arns = [
    "arn:aws:iam::111111111111:role/ci-runner",
    "arn:aws:iam::222222222222:role/aws-reserved/sso.amazonaws.com/eu-west-1/AWSReservedSSO_Dev_0123abcd",
  ]
  alarm_emails = ["ops@example.com"]
}

run "defaults" {
  command = plan

  assert {
    condition     = aws_s3_bucket.artifacts.bucket == "nx-cache-test-artifacts-111111111111"
    error_message = "The default bucket name is <name_prefix>-<environment>-artifacts-<account id>."
  }

  assert {
    # 02, AUTHZ-2: IAM paths are dropped, names keep their case.
    condition     = aws_lambda_function.handler.environment[0].variables["ALLOWED_ROLES"] == "[\"111111111111:ci-runner\",\"222222222222:AWSReservedSSO_Dev_0123abcd\"]"
    error_message = "ALLOWED_ROLES must hold <account>:<role name> pairs without IAM paths."
  }

  assert {
    condition = alltrue([
      aws_lambda_function.handler.environment[0].variables["STS_REGION"] == "eu-west-1",
      aws_lambda_function.handler.environment[0].variables["TOKEN_AUDIENCE"] == "nx-cache.example.com",
      aws_lambda_function.handler.environment[0].variables["TOKEN_MAX_LIFETIME_SECONDS"] == "3600",
      aws_lambda_function.handler.environment[0].variables["MAX_ARTIFACT_BYTES"] == "4194304",
      aws_lambda_function.handler.environment[0].variables["ENVIRONMENT"] == "test",
      aws_lambda_function.handler.environment[0].variables["CACHE_ENABLED"] == "true",
    ])
    error_message = "The handler environment does not match 03, FN-5."
  }

  assert {
    condition = alltrue([
      aws_lambda_function.handler.runtime == "nodejs24.x",
      aws_lambda_function.handler.architectures[0] == "arm64",
      aws_lambda_function.handler.memory_size == 1024,
      aws_lambda_function.handler.timeout == 20,
      aws_lambda_function.handler.reserved_concurrent_executions == -1,
      aws_lambda_function.handler.logging_config[0].log_format == "JSON",
    ])
    error_message = "The function settings do not match 03, FN-1 to FN-3."
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.artifacts.rule[0].expiration[0].days == 14
    error_message = "Artifacts expire after 14 days by default (04, LC-1)."
  }

  assert {
    condition     = aws_cloudwatch_log_group.handler.retention_in_days == 30 && aws_cloudwatch_log_group.access.retention_in_days == 30
    error_message = "Both log groups keep logs for log_retention_days (07, LOG-4)."
  }

  assert {
    condition     = aws_s3_bucket.artifacts.tags["Project"] == "nx-s3-serverless-cache" && aws_s3_bucket.artifacts.tags["Environment"] == "test"
    error_message = "Taggable resources carry Project and Environment (06, TF-7)."
  }

  assert {
    condition     = output.plugin_options == { url = "https://nx-cache.example.com", region = "eu-west-1", audience = "nx-cache.example.com" }
    error_message = "plugin_options must give url, region and audience."
  }

  assert {
    condition     = aws_api_gateway_rest_api.this.disable_execute_api_endpoint && aws_api_gateway_rest_api.this.binary_media_types == tolist(["*/*"])
    error_message = "The execute-api endpoint is off and every media type is binary (03, APIGW-1, APIGW-4)."
  }

  assert {
    condition     = aws_api_gateway_method_settings.all.settings[0].logging_level == "OFF" && !aws_api_gateway_method_settings.all.settings[0].data_trace_enabled
    error_message = "Execution logging must be off, or tokens would be logged (03, APIGW-8)."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.lambda_errors) == 1 && length(aws_sns_topic.alarms) == 1 && length(aws_sns_topic_subscription.email) == 1
    error_message = "Alarms notify a topic created for alarm_emails (07 section 4)."
  }
}

run "api_definition" {
  command = plan

  assert {
    condition     = jsondecode(aws_api_gateway_rest_api.this.body).paths["/{workspace}/v1/cache/{hash}"].put.security == [{ "size-gate" = [] }]
    error_message = "PUT passes the size gate (D-36)."
  }

  assert {
    condition     = !can(jsondecode(aws_api_gateway_rest_api.this.body).paths["/{workspace}/v1/cache/{hash}"].get.security)
    error_message = "GET has no authorizer: its failures could only be 403s, which fail Nx commands."
  }

  assert {
    condition = alltrue([
      for type in ["REQUEST_TOO_LARGE", "ACCESS_DENIED", "UNAUTHORIZED", "AUTHORIZER_FAILURE", "AUTHORIZER_CONFIGURATION_ERROR"] :
      jsondecode(aws_api_gateway_rest_api.this.body)["x-amazon-apigateway-gateway-responses"][type].statusCode == 403
    ])
    error_message = "Gateway responses that only PUT can trigger are 403, a skipped upload (D-34, D-36)."
  }

  assert {
    condition = alltrue([
      jsondecode(aws_api_gateway_rest_api.this.body)["x-amazon-apigateway-gateway-responses"]["MISSING_AUTHENTICATION_TOKEN"].statusCode == 404,
      !can(jsondecode(aws_api_gateway_rest_api.this.body)["x-amazon-apigateway-gateway-responses"]["DEFAULT_5XX"].statusCode),
      jsondecode(aws_api_gateway_rest_api.this.body)["x-amazon-apigateway-gateway-responses"]["THROTTLED"].responseParameters["gatewayresponse.header.Content-Type"] == "'text/plain'",
    ])
    error_message = "Gateway responses must match 03, APIGW-5."
  }
}

run "options_change_the_resources" {
  command = plan

  variables {
    name_prefix                 = "cache"
    bucket_name                 = "my-nx-cache-bucket"
    token_audience              = "nx-cache-prod"
    retention_days              = 7
    log_retention_days          = 14
    lambda_reserved_concurrency = 50
    cache_enabled               = false
    alarms_enabled              = false
    alarm_emails                = []
    manage_api_gateway_account  = true
  }

  assert {
    condition     = aws_s3_bucket.artifacts.bucket == "my-nx-cache-bucket" && aws_lambda_function.handler.function_name == "cache-test-handler"
    error_message = "bucket_name and name_prefix must be used."
  }

  assert {
    condition = alltrue([
      aws_lambda_function.handler.environment[0].variables["TOKEN_AUDIENCE"] == "nx-cache-prod",
      aws_lambda_function.handler.environment[0].variables["CACHE_ENABLED"] == "false",
      aws_lambda_function.handler.reserved_concurrent_executions == 50,
    ])
    error_message = "token_audience, cache_enabled and lambda_reserved_concurrency must reach the function."
  }

  assert {
    # ALM-1: no alarms, but the dashboard stays.
    condition     = length(aws_cloudwatch_metric_alarm.lambda_errors) == 0 && length(aws_cloudwatch_metric_alarm.upstream) == 0 && aws_cloudwatch_dashboard.this.dashboard_name == "cache-test"
    error_message = "alarms_enabled = false removes the alarms and keeps the dashboard."
  }

  assert {
    condition     = length(aws_api_gateway_account.this) == 1
    error_message = "manage_api_gateway_account creates the account-level logging role (06, TF-10)."
  }
}

run "existing_alarm_topic" {
  command = plan

  variables {
    alarm_emails        = []
    alarm_sns_topic_arn = "arn:aws:sns:eu-west-1:111111111111:ops"
  }

  assert {
    condition     = length(aws_sns_topic.alarms) == 0 && aws_cloudwatch_metric_alarm.lambda_errors[0].alarm_actions == toset(["arn:aws:sns:eu-west-1:111111111111:ops"])
    error_message = "An existing topic is used instead of creating one."
  }
}

run "alarms_without_recipients_warn" {
  command = plan

  variables {
    alarm_emails = []
  }

  # ALM-2: a warning, not an error. The plan still succeeds.
  expect_failures = [check.alarm_recipients]
}

# Preconditions ---------------------------------------------------------------

run "domain_outside_zone" {
  command = plan

  variables {
    domain_name = "nx-cache.other.org"
  }

  expect_failures = [aws_acm_certificate.this]
}

run "zone_suffix_is_not_enough" {
  command = plan

  variables {
    domain_name = "nx-cache.notexample.com"
  }

  expect_failures = [aws_acm_certificate.this]
}

run "environment_too_large" {
  command = plan

  variables {
    allowed_role_arns = [for i in range(80) : format("arn:aws:iam::%012d:role/a-rather-long-role-name-for-the-ci-runners-%02d", i, i)]
  }

  expect_failures = [aws_lambda_function.handler]
}

# Input validations -------------------------------------------------------------

run "invalid_environment" {
  command = plan
  variables {
    environment = "Production"
  }
  expect_failures = [var.environment]
}

run "invalid_name_prefix" {
  command = plan
  variables {
    name_prefix = "a-name-prefix-that-is-far-too-long"
  }
  expect_failures = [var.name_prefix]
}

run "invalid_domain_name" {
  command = plan
  variables {
    domain_name = "https://nx-cache.example.com"
  }
  expect_failures = [var.domain_name]
}

run "invalid_hosted_zone_name" {
  command = plan
  variables {
    hosted_zone_name = "Example Com"
  }
  expect_failures = [var.hosted_zone_name]
}

run "no_allowed_roles" {
  command = plan
  variables {
    allowed_role_arns = []
  }
  expect_failures = [var.allowed_role_arns]
}

run "allowed_role_wildcard" {
  command = plan
  variables {
    allowed_role_arns = ["arn:aws:iam::111111111111:role/ci-*"]
  }
  expect_failures = [var.allowed_role_arns]
}

run "allowed_role_is_a_user" {
  command = plan
  variables {
    allowed_role_arns = ["arn:aws:iam::111111111111:user/alice"]
  }
  expect_failures = [var.allowed_role_arns]
}

run "allowed_role_other_partition" {
  command = plan
  variables {
    allowed_role_arns = ["arn:aws-cn:iam::111111111111:role/ci-runner"]
  }
  expect_failures = [var.allowed_role_arns]
}

run "allowed_role_duplicate_after_normalization" {
  command = plan
  variables {
    allowed_role_arns = [
      "arn:aws:iam::111111111111:role/ci-runner",
      "arn:aws:iam::111111111111:role/team/CI-Runner",
    ]
  }
  expect_failures = [var.allowed_role_arns]
}

run "same_role_name_in_two_accounts_is_fine" {
  command = plan
  variables {
    allowed_role_arns = [
      "arn:aws:iam::111111111111:role/ci-runner",
      "arn:aws:iam::222222222222:role/ci-runner",
    ]
  }
}

run "missing_lambda_package" {
  command = plan
  variables {
    lambda_package_path = "tests/fixtures/missing.zip"
  }
  expect_failures = [var.lambda_package_path]
}

run "invalid_bucket_name" {
  command = plan
  variables {
    bucket_name = "Not_A_Bucket"
  }
  expect_failures = [var.bucket_name]
}

run "invalid_retention_days" {
  command = plan
  variables {
    retention_days = 0
  }
  expect_failures = [var.retention_days]
}

run "invalid_token_audience" {
  command = plan
  variables {
    token_audience = "has spaces"
  }
  expect_failures = [var.token_audience]
}

run "token_lifetime_too_short" {
  command = plan
  variables {
    token_max_lifetime_seconds = 899
  }
  expect_failures = [var.token_max_lifetime_seconds]
}

run "token_lifetime_too_long" {
  command = plan
  variables {
    token_max_lifetime_seconds = 43201
  }
  expect_failures = [var.token_max_lifetime_seconds]
}

run "artifact_limit_above_lambda_payload" {
  command = plan
  variables {
    max_artifact_bytes = 4500001
  }
  expect_failures = [var.max_artifact_bytes]
}

run "invalid_lambda_memory" {
  command = plan
  variables {
    lambda_memory_mb = 64
  }
  expect_failures = [var.lambda_memory_mb]
}

run "lambda_timeout_at_gateway_limit" {
  command = plan
  variables {
    lambda_timeout_seconds = 29
  }
  expect_failures = [var.lambda_timeout_seconds]
}

run "negative_reserved_concurrency" {
  command = plan
  variables {
    lambda_reserved_concurrency = -1
  }
  expect_failures = [var.lambda_reserved_concurrency]
}

run "invalid_throttle_rate" {
  command = plan
  variables {
    api_throttle_rate_limit = 0
  }
  expect_failures = [var.api_throttle_rate_limit]
}

run "invalid_throttle_burst" {
  command = plan
  variables {
    api_throttle_burst_limit = 0
  }
  expect_failures = [var.api_throttle_burst_limit]
}

run "unsupported_log_retention" {
  command = plan
  variables {
    log_retention_days = 21
  }
  expect_failures = [var.log_retention_days]
}

run "log_retention_below_artifact_retention" {
  command = plan
  variables {
    retention_days     = 30
    log_retention_days = 14
  }
  expect_failures = [var.log_retention_days]
}

run "invalid_alarm_email" {
  command = plan
  variables {
    alarm_emails = ["not-an-email"]
  }
  expect_failures = [var.alarm_emails]
}

run "invalid_alarm_topic" {
  command = plan
  variables {
    alarm_emails        = []
    alarm_sns_topic_arn = "ops-topic"
  }
  expect_failures = [var.alarm_sns_topic_arn]
}

run "alarm_emails_and_topic_together" {
  command = plan
  variables {
    alarm_sns_topic_arn = "arn:aws:sns:eu-west-1:111111111111:ops"
  }
  expect_failures = [var.alarm_sns_topic_arn]
}

run "invalid_admin_role" {
  command = plan
  variables {
    admin_role_arns = ["arn:aws:iam::111111111111:user/admin"]
  }
  expect_failures = [var.admin_role_arns]
}
