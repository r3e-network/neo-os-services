-- The Neo X adapter persists durable relayer jobs with chain = 'neox'. The
-- original 0004 constraint allowed only 'neo_n3', so fail-closed queue inserts
-- rejected every real Neo X event before the request cursor could advance.
--
-- This migration changes only the accepted chain discriminator. It does not
-- activate Neo X, change active-chain configuration, or alter any RLS policy.

ALTER TABLE public.morpheus_relayer_jobs
  DROP CONSTRAINT IF EXISTS morpheus_relayer_jobs_chain_check;

ALTER TABLE public.morpheus_relayer_jobs
  ADD CONSTRAINT morpheus_relayer_jobs_chain_check
  CHECK (chain IN ('neo_n3', 'neox')) NOT VALID;

ALTER TABLE public.morpheus_relayer_jobs
  VALIDATE CONSTRAINT morpheus_relayer_jobs_chain_check;
