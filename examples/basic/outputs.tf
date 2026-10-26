output "endpoint_url" {
  description = "Base URL of the cache."
  value       = module.nx_cache.endpoint_url
}

output "plugin_options" {
  description = "Paste into nx.json with a workspace ID."
  value       = module.nx_cache.plugin_options
}

output "dashboard_region" {
  description = "Region of the CloudWatch dashboard and alarms."
  value       = module.nx_cache.region
}
