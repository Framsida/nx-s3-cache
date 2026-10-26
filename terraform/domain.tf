# Custom domain (03, APIGW-2): ACM certificate validated in the existing zone,
# a regional API Gateway domain with TLS 1.2 or newer, and an alias record.

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  tags              = local.tags

  lifecycle {
    create_before_destroy = true

    # TF-4
    precondition {
      condition     = var.domain_name == local.zone_name || endswith(var.domain_name, ".${local.zone_name}")
      error_message = "domain_name (${var.domain_name}) must be the hosted zone's name or end with .${local.zone_name}."
    }
  }
}

locals {
  validation_options = {
    for o in aws_acm_certificate.this.domain_validation_options : o.domain_name => o
  }
}

resource "aws_route53_record" "validation" {
  # Static keys, so the plan never depends on values the certificate only has
  # after it is created.
  for_each = toset([var.domain_name])

  zone_id         = data.aws_route53_zone.this.zone_id
  name            = local.validation_options[each.key].resource_record_name
  type            = local.validation_options[each.key].resource_record_type
  records         = [local.validation_options[each.key].resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_api_gateway_domain_name" "this" {
  domain_name              = var.domain_name
  regional_certificate_arn = aws_acm_certificate_validation.this.certificate_arn
  security_policy          = "TLS_1_2"

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = local.tags
}

resource "aws_api_gateway_base_path_mapping" "this" {
  api_id      = aws_api_gateway_rest_api.this.id
  stage_name  = aws_api_gateway_stage.this.stage_name
  domain_name = aws_api_gateway_domain_name.this.domain_name
}

resource "aws_route53_record" "alias" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_api_gateway_domain_name.this.regional_domain_name
    zone_id                = aws_api_gateway_domain_name.this.regional_zone_id
    evaluate_target_health = false
  }
}
