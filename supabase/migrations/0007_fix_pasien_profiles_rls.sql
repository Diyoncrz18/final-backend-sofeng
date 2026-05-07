-- =====================================================================
-- 0007_fix_pasien_profiles_rls.sql
-- ---------------------------------------------------------------------
-- Fix: pasien_profiles upsert/insert dari service_role masih kena RLS
-- di beberapa versi Supabase karena policy terlalu ketat.
--
-- Solusi:
--   1. Tambah bypass eksplisit untuk service_role di pasien_profiles.
--   2. Tambah INSERT policy untuk chat_conversations (backend butuh ini).
-- =====================================================================

-- ── pasien_profiles: izinkan service_role INSERT tanpa check ──────────
-- service_role sudah bypass RLS secara default di Supabase hosted, tapi
-- untuk Supabase self-hosted atau beberapa konfigurasi, perlu policy ini.
drop policy if exists pasien_insert_service_role on public.pasien_profiles;
create policy pasien_insert_service_role on public.pasien_profiles
  for insert
  to service_role
  with check (true);

-- ── pasien_profiles: izinkan service_role SELECT ─────────────────────
drop policy if exists pasien_select_service_role on public.pasien_profiles;
create policy pasien_select_service_role on public.pasien_profiles
  for select
  to service_role
  using (true);

-- ── pasien_profiles: izinkan service_role UPDATE ─────────────────────
drop policy if exists pasien_update_service_role on public.pasien_profiles;
create policy pasien_update_service_role on public.pasien_profiles
  for update
  to service_role
  using (true)
  with check (true);

-- ── chat_conversations: backend butuh INSERT (service_role) ──────────
drop policy if exists chat_conversations_insert_pasien on public.chat_conversations;
create policy chat_conversations_insert_pasien on public.chat_conversations
  for insert
  to authenticated
  with check (
    auth.uid() = pasien_id
    and exists (
      select 1
      from public.dokter_profiles d
      where d.id = dokter_id
    )
  );

drop policy if exists chat_conversations_insert_service_role on public.chat_conversations;
create policy chat_conversations_insert_service_role on public.chat_conversations
  for insert
  to service_role
  with check (true);

drop policy if exists chat_conversations_update_service_role on public.chat_conversations;
create policy chat_conversations_update_service_role on public.chat_conversations
  for update
  to service_role
  using (true)
  with check (true);

drop policy if exists chat_conversations_select_service_role on public.chat_conversations;
create policy chat_conversations_select_service_role on public.chat_conversations
  for select
  to service_role
  using (true);

-- ── chat_messages: backend butuh INSERT dan UPDATE (service_role) ─────
drop policy if exists chat_messages_insert_participant on public.chat_messages;
create policy chat_messages_insert_participant on public.chat_messages
  for insert
  to authenticated
  with check (
    auth.uid() = sender_id
    and exists (
      select 1
      from public.chat_conversations c
      where c.id = conversation_id
        and (c.pasien_id = auth.uid() or c.dokter_id = auth.uid())
        and c.status = 'aktif'
    )
  );

drop policy if exists chat_messages_insert_service_role on public.chat_messages;
create policy chat_messages_insert_service_role on public.chat_messages
  for insert
  to service_role
  with check (true);

drop policy if exists chat_messages_select_service_role on public.chat_messages;
create policy chat_messages_select_service_role on public.chat_messages
  for select
  to service_role
  using (true);

drop policy if exists chat_messages_update_service_role on public.chat_messages;
create policy chat_messages_update_service_role on public.chat_messages
  for update
  to service_role
  using (true)
  with check (true);

-- =====================================================================
-- DONE.
-- =====================================================================
