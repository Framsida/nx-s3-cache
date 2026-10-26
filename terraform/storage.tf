# Artifact storage (04).

resource "aws_s3_bucket" "artifacts" {
  bucket = local.bucket_name
  tags   = local.tags
}

# S3-2
resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# S3-3
resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# S3-4. Versioning stays off (S3-5): conditional writes protect records.
resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# LC-1 to LC-3
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-artifacts"
    status = "Enabled"

    filter {
      prefix = "v1/"
    }

    expiration {
      days = var.retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  # S3-POL-1
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # S3-POL-2: only the handler and admins read or write cache data, whatever
  # other identities' IAM policies allow. Bucket policy changes are not denied.
  statement {
    sid       = "DenyDataAccessExceptHandlerAndAdmins"
    effect    = "Deny"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${local.bucket_arn}/v1/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = concat([aws_iam_role.handler.arn], var.admin_role_arns)
    }
  }

  # S3-POL-3: only admins delete (purges, 02 R1-M4). Lifecycle expiry is not
  # affected by bucket policies.
  statement {
    sid       = "DenyDeleteExceptAdmins"
    effect    = "Deny"
    actions   = ["s3:DeleteObject"]
    resources = ["${local.bucket_arn}/v1/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    dynamic "condition" {
      for_each = length(var.admin_role_arns) > 0 ? [1] : []
      content {
        test     = "ArnNotEquals"
        variable = "aws:PrincipalArn"
        values   = var.admin_role_arns
      }
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}
