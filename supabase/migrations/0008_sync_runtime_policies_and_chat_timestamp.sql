-- =====================================================================
-- 0008_sync_runtime_policies_and_chat_timestamp.sql
-- ---------------------------------------------------------------------
-- Sinkronisasi kecil antara schema Supabase aktual dan kontrak runtime
-- backend/frontend.
--
-- Fokus:
--   1. Pastikan policy direct-auth chat dari 0007 ada di database.
--   2. Tambahkan policy service_role UPDATE untuk pasien_profiles agar
--      eksplisit walau hosted Supabase normalnya bypass RLS.
--   3. Pasang trigger updated_at untuk chat_conversations.
-- =====================================================================

drop policy if exists pasien_update_service_role on public.pasien_profiles;
create policy pasien_update_service_role on public.pasien_profiles
  for update
  to service_role
  using (true)
  with check (true);

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

drop trigger if exists set_updated_at on public.chat_conversations;
create trigger set_updated_at
  before update on public.chat_conversations
  for each row execute function public.set_updated_at();

-- =====================================================================
-- DONE.
-- =====================================================================
