create index if not exists idx_morpheus_relayer_jobs_network_chain_status_retry
  on morpheus_relayer_jobs(network, chain, status, next_retry_at, updated_at desc);

create index if not exists idx_morpheus_relayer_jobs_network_status_updated
  on morpheus_relayer_jobs(network, status, updated_at desc);

create index if not exists idx_morpheus_feed_snapshots_network_created_at
  on morpheus_feed_snapshots(network, created_at desc);

create index if not exists idx_morpheus_feed_snapshots_network_target_chain_created_at
  on morpheus_feed_snapshots(network, target_chain, created_at desc);
