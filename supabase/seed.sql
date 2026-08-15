insert into morpheus_projects (network, slug, name, owner_wallet)
values
  ('mainnet', 'demo', 'Morpheus Demo Project', 'NhDemoWalletPlaceholder'),
  ('testnet', 'demo', 'Morpheus Demo Project (Testnet)', 'NhDemoWalletPlaceholder')
on conflict (network, slug) do nothing;

insert into morpheus_feed_snapshots (network, symbol, target_chain, price, payload)
values
  ('mainnet', 'NEO-USD', 'neo_n3', 0, '{"source":"seed","network":"mainnet"}'::jsonb),
  ('testnet', 'NEO-USD', 'neo_n3', 0, '{"source":"seed","network":"testnet"}'::jsonb)
on conflict do nothing;
