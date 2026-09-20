# Supabase Setup

Apply the migrations in order:

1. `0001_morpheus_schema.sql`
2. `0002_morpheus_policies_and_seeds.sql`
3. `0003_provider_configs.sql`
4. `0004_relayer_ops.sql`
5. `0005_operation_logs.sql`
6. `0006_automation.sql`
7. `0007_system_backups.sql`
8. `0008_network_isolation.sql`
9. `0009_relayer_durable_queue_indexes.sql`
10. `0010_control_plane_jobs.sql`
11. `0011_workflow_runtime.sql`
12. `0012_policy_and_risk_controls.sql`
13. `0013_automation_processing_claims.sql`
14. `0014_tighten_request_job_rls.sql`
15. `0015_harden_operational_table_rls.sql`
16. `0016_allow_neox_relayer_jobs.sql`
17. `0017_workflow_registry.sql`
18. `0018_secret_rotation.sql`
19. `0019_tighten_workflow_namespace.sql`
20. `0020_harden_remaining_rls.sql`
21. `20260806223618_network_scoped_business_keys.sql`
22. `20260806231613_distributed_rate_limits.sql`
23. `20260908040427_relayer_delivery_v2.sql`
24. `20260920102300_relayer_delivery_completion_identity.sql`

Optional:

- `supabase/seed.sql`

## What gets created

- project registry
- encrypted secret storage
- async request records
- control-plane jobs
- compute job records
- feed snapshots
- relayer durable jobs
- automation jobs and automation runs
- built-in compute function catalog
- RLS policies for project-owned data
- network-scoped project registry and network-separated operational data for mainnet vs testnet
