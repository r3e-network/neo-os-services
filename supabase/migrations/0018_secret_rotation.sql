-- Secret rotation & TTL (P0-2 milestone).
--
-- Adds owner rotation/removal (update/delete RLS) to morpheus_encrypted_secrets,
-- plus an optional expiry so developers can bound the lifetime of a stored
-- ciphertext ref. Ciphertext is always client-sealed (X25519-HKDF-SHA256-AES-256-GCM),
-- so the service only ever stores opaque ciphertext — rotation here means replacing
-- the ciphertext + bumping key_version, never server-side decryption.

alter table morpheus_encrypted_secrets
  add column if not exists expires_at timestamptz;

create index if not exists idx_morpheus_encrypted_secrets_expires
  on morpheus_encrypted_secrets(expires_at)
  where expires_at is not null;

-- Owners may rotate (update) their own secrets through the owning project,
-- mirroring the select/insert policies already in 0002.
drop policy if exists morpheus_secrets_update_own on morpheus_encrypted_secrets;
create policy morpheus_secrets_update_own on morpheus_encrypted_secrets
for update to authenticated
using (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_secrets_delete_own on morpheus_encrypted_secrets;
create policy morpheus_secrets_delete_own on morpheus_encrypted_secrets
for delete to authenticated
using (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);
