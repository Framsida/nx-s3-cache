# Module outputs (06 §4).

output "endpoint_url" {
  description = "Base URL of the cache."
  value       = "https://${var.domain_name}"
}

output "region" {
  description = "Region the cache is deployed in, taken from the AWS provider (06, TF-3)."
  value       = local.region
}

output "rest_api_id" {
  description = "API Gateway REST API ID."
  value       = aws_api_gateway_rest_api.this.id
}

output "stage_name" {
  description = "API Gateway stage name."
  value       = aws_api_gateway_stage.this.stage_name
}

output "bucket_name" {
  description = "Artifact bucket."
  value       = aws_s3_bucket.artifacts.bucket
}

output "lambda_function_name" {
  description = "Handler function name."
  value       = aws_lambda_function.handler.function_name
}

output "lambda_role_arn" {
  description = "Handler execution role."
  value       = aws_iam_role.handler.arn
}

output "alarm_topic_arn" {
  description = "SNS topic the alarms notify, or null when alarms have no recipients."
  value       = local.alarm_topic_arn
}

output "plugin_options" {
  description = "Paste into the nx-s3-serverless-cache plugin entry in nx.json, with a workspace ID (05 §2)."
  value = {
    url      = "https://${var.domain_name}"
    region   = local.region
    audience = local.audience
  }
}
