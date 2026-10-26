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
25. `20261012120000_relayer_delivery_sponsor.sql`

Optional:

- `seed.sql` (in this directory)

## What gets created

- project registry
- encrypted secret storage
- async request records
- control-plane jobs
- compute job records
- feed snapshots
- relayer durable jobs
- sponsor intent journal and reserved fee/action budgets for the delivery kind `sponsor`
- automation jobs and automation runs
- built-in compute function catalog
- RLS policies for project-owned data
- network-scoped project registry and network-separated operational data for mainnet vs testnet

### Caller migration: explicit PostgREST schema preimage

Migration `20261026090000_relayer_delivery_caller_scope.sql` refuses a missing, empty or whitespace-only role-scoped `pgrst.db_schemas` preimage. An absent catalog entry does not establish the effective API configuration: owner configuration can supply additional schemas. Before any future migration, the operator must independently compare the effective API configuration and explicitly seed its exact schema list on the authenticator role at the intended database/global scope. The migration preserves that text/order and appends `neoos_relayer_v2` only when absent; an unknown pre-request hook still requires separate composition admission. No production default or automatic owner-configuration lookup is supplied. Cloud DDL, old-worker shutdown and new-caller activation remain held.

The existing disposable PostgreSQL runner explicitly seeds its own known `public,graphql_public` fixture. Its caller acceptance reads the exact migration source using the test-only `NEOOS_CALLER_SCOPE_MIGRATION_FIXTURE` path, executes the body in rollback-controlled subtransactions, and checks unknown/empty refusal, whole-migration rollback, known-schema/order preservation, v2 duplicate avoidance and unknown-hook refusal. These SQL regressions require the disposable suite's local test-owner privileges; source/static checks are not PostgreSQL execution evidence.
