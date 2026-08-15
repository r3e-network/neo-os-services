-- Tighten the workflow registry namespace check to require the network segment.
--
-- 0017 enforced `workflow_id like 'user.%'`, which still allowed a 3-segment id
-- (user.<slug>.<name>) from a direct authenticated insert — reintroducing the
-- cross-network name-existence leak even though global uniqueness blocks the
-- actual collision. Requiring the network segment matches the app-layer id
-- builder (user.<network>.<slug>.<name>) as defense-in-depth.

alter table morpheus_workflow_registry
  drop constraint if exists morpheus_workflow_registry_user_namespace;

alter table morpheus_workflow_registry
  add constraint morpheus_workflow_registry_user_namespace
  check (workflow_id like 'user.%.%.%');
