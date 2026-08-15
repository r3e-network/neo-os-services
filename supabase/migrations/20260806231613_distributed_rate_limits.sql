-- Transactional distributed fallback for web rate limiting. Redis remains the
-- preferred low-latency backend, but production must not become unavailable
-- merely because a Marketplace resource has not yet been provisioned.
create table if not exists morpheus_rate_limit_counters (
  counter_key text primary key,
  request_count bigint not null default 0 check (request_count >= 0),
  window_started_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_morpheus_rate_limit_counters_expires_at
  on morpheus_rate_limit_counters(expires_at);

alter table morpheus_rate_limit_counters enable row level security;

revoke all on table morpheus_rate_limit_counters from public;
revoke all on table morpheus_rate_limit_counters from anon;
revoke all on table morpheus_rate_limit_counters from authenticated;
grant all on table morpheus_rate_limit_counters to service_role;

create or replace function morpheus_consume_rate_limit(
  p_key text,
  p_window_ms integer
)
returns table(current_count bigint, ttl_ms bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  request_time timestamptz := clock_timestamp();
begin
  if p_key is null or btrim(p_key) = '' or octet_length(p_key) > 1024 then
    raise exception 'invalid rate-limit key' using errcode = '22023';
  end if;
  if p_window_ms < 1000 or p_window_ms > 86400000 then
    raise exception 'invalid rate-limit window' using errcode = '22023';
  end if;

  return query
  insert into morpheus_rate_limit_counters (
    counter_key,
    request_count,
    window_started_at,
    expires_at,
    updated_at
  )
  values (
    p_key,
    1,
    request_time,
    request_time + (p_window_ms * interval '1 millisecond'),
    request_time
  )
  on conflict (counter_key) do update
  set
    request_count = case
      when morpheus_rate_limit_counters.expires_at <= request_time then 1
      else morpheus_rate_limit_counters.request_count + 1
    end,
    window_started_at = case
      when morpheus_rate_limit_counters.expires_at <= request_time then request_time
      else morpheus_rate_limit_counters.window_started_at
    end,
    expires_at = case
      when morpheus_rate_limit_counters.expires_at <= request_time
        then request_time + (p_window_ms * interval '1 millisecond')
      else morpheus_rate_limit_counters.expires_at
    end,
    updated_at = request_time
  returning
    morpheus_rate_limit_counters.request_count,
    greatest(
      0,
      ceil(
        extract(epoch from (morpheus_rate_limit_counters.expires_at - request_time)) * 1000
      )::bigint
    );
end;
$$;

revoke all on function morpheus_consume_rate_limit(text, integer) from public;
revoke all on function morpheus_consume_rate_limit(text, integer) from anon;
revoke all on function morpheus_consume_rate_limit(text, integer) from authenticated;
grant execute on function morpheus_consume_rate_limit(text, integer) to service_role;
