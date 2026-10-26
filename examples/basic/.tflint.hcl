# Offline lint (06, TF-11). Only the bundled Terraform ruleset: it needs no
# download and no AWS credentials.
plugin "terraform" {
  enabled = true
  preset  = "all"
}
