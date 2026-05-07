-- Aktifkan Supabase Realtime untuk feed notifikasi dokter/pasien.
-- Idempotent: aman dijalankan ulang di database yang sudah punya publikasi ini.

alter table public.notifikasi replica identity full;

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifikasi'
  ) then
    alter publication supabase_realtime add table public.notifikasi;
  end if;
end $$;
