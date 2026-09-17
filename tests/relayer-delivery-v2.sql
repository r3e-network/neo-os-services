begin;
set local role service_role;
do $$
declare a jsonb; b jsonb; gen bigint;
begin
  if has_function_privilege('anon','morpheus_delivery_claim(text,text,text,text,bigint,text[])','EXECUTE') then raise exception 'public may claim private jobs'; end if;
  perform morpheus_delivery_enqueue('mainnet','neox','0x01','7','updater','{"requestId":"7","payload":"x"}');
  a := morpheus_delivery_claim('mainnet','neox','updater','A',60000);
  if a is null then raise exception 'first claim missing'; end if;
  b := morpheus_delivery_claim('mainnet','neox','updater','B',60000);
  if b is not null then raise exception 'double claim'; end if;
  gen := (a->>'generation')::bigint;
  begin
    perform morpheus_delivery_transition(a->>'job_key','A',null,'renew','{}',60000);
    raise exception 'null fencing generation accepted';
  exception when sqlstate 'P0002' then null;
  end;
  perform morpheus_delivery_transition(a->>'job_key','A',gen,'prepared','{"result":"fixed"}',60000);
  perform morpheus_delivery_transition(a->>'job_key','A',gen,'signed','{"tx_hash":"0xabc","raw":"0xbeef"}',60000);
  -- An expired owner's callback may never complete or renew after takeover.
  update morpheus_delivery_jobs set lease_until=clock_timestamp()-interval '1 second';
  b := morpheus_delivery_claim('mainnet','neox','updater','B',60000);
  if b->'journal'->'signed'->>'raw' <> '0xbeef' then raise exception 'journal lost on takeover'; end if;
  begin
    perform morpheus_delivery_transition(a->>'job_key','A',gen,'renew','{}',60000);
    raise exception 'stale lease accepted';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform morpheus_delivery_transition(a->>'job_key','A',gen,'completed','{"tx_hash":"0xabc","vm_state":"HALT"}',60000);
    raise exception 'stale completion accepted';
  exception when sqlstate 'P0002' then null;
  end;
  perform morpheus_delivery_enqueue('mainnet','neox','0x01','8','updater','{"requestId":"8"}');
  if morpheus_delivery_claim('mainnet','neox','updater','C',60000) is not null then raise exception 'account nonce not serialized'; end if;
  perform morpheus_delivery_transition(b->>'job_key','B',(b->>'generation')::bigint,'completed','{"tx_hash":"0xabc","vm_state":"HALT"}',60000);
  a := morpheus_delivery_claim('mainnet','neox','updater','C',60000);
  perform morpheus_delivery_transition(a->>'job_key','C',(a->>'generation')::bigint,'retry','{"error":"transient"}',60000);
  if morpheus_delivery_claim('mainnet','neox','updater','D',60000) is not null then raise exception 'future retry executed'; end if;
  update morpheus_delivery_jobs set next_attempt_at=clock_timestamp()-interval '1 second' where request_id='8';
  a := morpheus_delivery_claim('mainnet','neox','updater','D',60000);
  perform morpheus_delivery_transition(a->>'job_key','D',(a->>'generation')::bigint,'terminal','{"error":"bad input"}',60000);
  if morpheus_delivery_claim('mainnet','neox','updater','E',60000) is not null then raise exception 'terminal job reclaimed'; end if;
  perform morpheus_delivery_replay(a->>'job_key','operator','fixed input classification');
  if morpheus_delivery_claim('mainnet','neox','updater','E',60000) is null then raise exception 'explicit replay not ready'; end if;
end $$;
do $$
declare feed jsonb; again jsonb; request jsonb; j jsonb;
begin
  feed:=morpheus_delivery_enqueue('testnet','neo_n3','feed','1','mixed','{"kind":"feed","requestId":"1"}');
  again:=morpheus_delivery_enqueue('testnet','neo_n3','feed','2','mixed','{"kind":"feed","requestId":"2"}');
  if feed->>'job_key'<>again->>'job_key' then raise exception 'feed backlog is not coalesced'; end if;
  request:=morpheus_delivery_enqueue('testnet','neo_n3','oracle','1','mixed','{"requestId":"1"}');
  j:=morpheus_delivery_claim('testnet','neo_n3','mixed','worker',60000);
  if j->>'kind'<>'feed' then raise exception 'oldest unserved lane not chosen'; end if;
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'no_update','{"decision":"no-update"}',60000);
  perform morpheus_delivery_enqueue('testnet','neo_n3','feed','3','mixed','{"kind":"feed","requestId":"3"}');
  j:=morpheus_delivery_claim('testnet','neo_n3','mixed','worker',60000);
  if j->>'kind'<>'request' then raise exception 'feed starved request lane'; end if;
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'reconciled','{"vm_state":"RECONCILED","onchain_state":{"request_id":"1","contract":"oracle","status":2}}',60000);
  j:=morpheus_delivery_import_legacy('testnet','neo_n3','oracle','1','mixed','{"requestId":"1"}','{"status":"retry_scheduled","attempts":1}');
  if j->>'status'<>'completed' then raise exception 'old retry downgraded completed job'; end if;
  j:=morpheus_delivery_claim('testnet','neo_n3','mixed','worker',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'prepared','{"feed_response":{"rounds":[7]},"feed_baseline_patch":{"NEO":{"round":"7","price":1}}}',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'signed','{"tx_hash":"feedtx","raw":"signed-feed"}',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'completed','{"tx_hash":"feedtx","vm_state":"HALT"}',60000);
  if morpheus_delivery_feed_baseline('testnet','neo_n3','feed')->'NEO'->>'round' <> '7' then raise exception 'confirmed baseline not durable'; end if;
  perform morpheus_delivery_enqueue('testnet','neo_n3','feed','4','mixed','{"kind":"feed","requestId":"4"}');
  j:=morpheus_delivery_claim('testnet','neo_n3','mixed','worker',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'prepared','{"feed_baseline_patch":{"GAS":{"round":"9"}}}',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'signed','{"tx_hash":"feedtx2","raw":"signed-feed2"}',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'completed','{"tx_hash":"feedtx2","vm_state":"HALT"}',60000);
  if morpheus_delivery_feed_baseline('testnet','neo_n3','feed')->'NEO'->>'round' <> '7' or morpheus_delivery_feed_baseline('testnet','neo_n3','feed')->'GAS'->>'round' <> '9' then raise exception 'partial feed update lost other symbols'; end if;
  perform morpheus_delivery_feed_baseline('testnet','neo_n3','feed','{"NEO":{"round":"1"}}');
  if morpheus_delivery_feed_baseline('testnet','neo_n3','feed')->'NEO'->>'round' <> '7' then raise exception 'stale local seed overwrote DB baseline'; end if;
  j:=morpheus_delivery_import_legacy('testnet','neox','oracle','4','legacy','{"requestId":"4"}','{"status":"retry_scheduled","attempts":2}');
  if j->>'status'<>'reconcile_required' then raise exception 'legacy uncertainty executed'; end if;
  if morpheus_delivery_claim('testnet','neox','legacy','worker',60000) is not null then raise exception 'legacy quarantine bypass'; end if;
  perform morpheus_delivery_resolve_legacy(j->>'job_key','operator','reviewed chain and pending nonce evidence');
  j:=morpheus_delivery_claim('testnet','neox','legacy','worker',60000);
  if j is null then raise exception 'resolved legacy not claimable'; end if;
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'terminal','{"error":"new classification"}',60000);
  perform morpheus_delivery_replay(j->>'job_key','operator','fixed classification');
  j:=morpheus_delivery_import_legacy('testnet','neox','oracle','4','legacy','{"requestId":"4"}','{"status":"retry_scheduled","attempts":2}');
  if j->>'status'<>'queued' then raise exception 'repeated legacy import undid explicit replay'; end if;
end $$;
do $$
declare j jsonb; evidence jsonb;
begin
  perform morpheus_delivery_enqueue('mainnet','neo_n3','oracle','77','expiry','{"requestId":"77"}');
  j:=morpheus_delivery_claim('mainnet','neo_n3','expiry','worker',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'prepared','{}',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'signed','{"tx_hash":"expiredtx","raw":"signed","valid_until_block":100}',60000);
  evidence:=jsonb_build_object('tx_hash','expiredtx','vm_state','EXPIRED_UNSEEN','onchain_state',jsonb_build_object('valid_until_block',100,'archive_checks',jsonb_build_array(
    jsonb_build_object('rpc_id',repeat('a',64),'tip',101,'expiry_hash','0x'||repeat('c',64)),
    jsonb_build_object('rpc_id',repeat('b',64),'tip',102,'expiry_hash','0x'||repeat('c',64)))));
  j:=morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'expired',evidence,60000);
  if j->>'status'<>'retry_scheduled' or j->'journal' ? 'signed' then raise exception 'proven expiry did not archive and schedule fresh attempt'; end if;
  perform morpheus_delivery_enqueue('mainnet','neox','oracle','88','fault','{"requestId":"88"}');
  j:=morpheus_delivery_claim('mainnet','neox','fault','worker',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'prepared','{}',60000);
  perform morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'signed','{"tx_hash":"faulttx","raw":"signed"}',60000);
  j:=morpheus_delivery_transition(j->>'job_key','worker',(j->>'generation')::bigint,'faulted','{"tx_hash":"faulttx","vm_state":"FAULT"}',60000);
  if j->>'status'<>'dead_letter' then raise exception 'confirmed fault should release account'; end if;
  perform morpheus_delivery_replay(j->>'job_key','operator','fixed finalized failure');
  j:=morpheus_delivery_lookup(j->>'job_key');
  if j->>'status'<>'queued' or j->'journal' ? 'signed' then raise exception 'finalized failure replay retained old signed plan'; end if;
end $$;
rollback;
