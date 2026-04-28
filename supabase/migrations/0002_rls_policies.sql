-- =====================================================================
-- 0002_rls_policies.sql
-- ---------------------------------------------------------------------
-- Klinik Gigi — Row Level Security policies untuk semua tabel public.*
--
-- PRASYARAT : 0001_initial_schema.sql sudah dijalankan.
-- IDEMPOTEN : Aman dijalankan ulang (semua policy di-drop dulu).
--
-- PRINSIP   :
--   • Pasien hanya akses datanya sendiri.
--   • Dokter akses semua pasien (untuk listing & treatment).
--   • Service role (backend dengan SERVICE_ROLE_KEY) bypass semua RLS.
-- =====================================================================


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ Helper function: current_user_role()                             │
-- └─────────────────────────────────────────────────────────────────┘
-- SECURITY DEFINER → bypass RLS waktu lookup ke profiles (kalau tidak,
-- policy 'profiles_select' akan recursive). search_path eksplisit = anti
-- search_path injection.
create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

comment on function public.current_user_role is
  'Ambil role user yang sedang login. Dipakai di policy untuk cek akses dokter.';


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ Enable RLS on all tables                                         │
-- └─────────────────────────────────────────────────────────────────┘
alter table public.profiles         enable row level security;
alter table public.pasien_profiles  enable row level security;
alter table public.dokter_profiles  enable row level security;
alter table public.jadwal_dokter    enable row level security;
alter table public.appointments     enable row level security;
alter table public.rekam_medis      enable row level security;
alter table public.triage_kasus     enable row level security;
alter table public.antrian          enable row level security;
alter table public.notifikasi       enable row level security;


-- =====================================================================
-- 1. profiles
-- =====================================================================
-- SELECT : user lihat profil sendiri + semua dokter (untuk listing publik).
-- UPDATE : hanya profil sendiri.
-- INSERT : ditangani oleh trigger handle_new_user (server-side).
-- DELETE : ditangani via cascade dari auth.users; tidak ada policy DELETE.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    auth.uid() = id
    or role = 'dokter'
  );

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- =====================================================================
-- 2. pasien_profiles
-- =====================================================================
-- SELECT : pasien lihat sendiri + dokter lihat semua pasien.
-- INSERT : pasien insert profile sendiri (sekali, saat onboarding).
-- UPDATE : pasien update sendiri; dokter UPDATE catatan_medis (via backend
--          service_role kalau perlu policy lebih spesifik).
drop policy if exists pasien_select on public.pasien_profiles;
create policy pasien_select on public.pasien_profiles
  for select to authenticated
  using (
    auth.uid() = id
    or public.current_user_role() = 'dokter'
  );

drop policy if exists pasien_insert_self on public.pasien_profiles;
create policy pasien_insert_self on public.pasien_profiles
  for insert to authenticated
  with check (auth.uid() = id);

drop policy if exists pasien_update_self on public.pasien_profiles;
create policy pasien_update_self on public.pasien_profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists pasien_update_dokter on public.pasien_profiles;
create policy pasien_update_dokter on public.pasien_profiles
  for update to authenticated
  using (public.current_user_role() = 'dokter')
  with check (public.current_user_role() = 'dokter');


-- =====================================================================
-- 3. dokter_profiles
-- =====================================================================
-- SELECT : siapapun authenticated bisa lihat (untuk pilih dokter saat booking).
-- INSERT : dokter daftar profile sendiri.
-- UPDATE : dokter update sendiri.
drop policy if exists dokter_select_all on public.dokter_profiles;
create policy dokter_select_all on public.dokter_profiles
  for select to authenticated
  using (true);

drop policy if exists dokter_insert_self on public.dokter_profiles;
create policy dokter_insert_self on public.dokter_profiles
  for insert to authenticated
  with check (auth.uid() = id);

drop policy if exists dokter_update_self on public.dokter_profiles;
create policy dokter_update_self on public.dokter_profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- =====================================================================
-- 4. jadwal_dokter
-- =====================================================================
-- SELECT : siapapun authenticated (pasien butuh ini saat booking).
-- ALL    : dokter manage jadwalnya sendiri.
drop policy if exists jadwal_select_all on public.jadwal_dokter;
create policy jadwal_select_all on public.jadwal_dokter
  for select to authenticated
  using (true);

drop policy if exists jadwal_manage_own on public.jadwal_dokter;
create policy jadwal_manage_own on public.jadwal_dokter
  for all to authenticated
  using (auth.uid() = dokter_id)
  with check (auth.uid() = dokter_id);


-- =====================================================================
-- 5. appointments
-- =====================================================================
-- SELECT : pasien & dokter terkait.
-- INSERT : pasien buat appointment sendiri.
-- UPDATE : pasien (cancel/reschedule) atau dokter (update status, catatan).
-- DELETE : pasien hanya boleh delete kalau status masih 'terjadwal'.
drop policy if exists appt_select on public.appointments;
create policy appt_select on public.appointments
  for select to authenticated
  using (
    auth.uid() = pasien_id
    or auth.uid() = dokter_id
  );

drop policy if exists appt_insert_pasien on public.appointments;
create policy appt_insert_pasien on public.appointments
  for insert to authenticated
  with check (auth.uid() = pasien_id);

drop policy if exists appt_update on public.appointments;
create policy appt_update on public.appointments
  for update to authenticated
  using (auth.uid() = pasien_id or auth.uid() = dokter_id)
  with check (auth.uid() = pasien_id or auth.uid() = dokter_id);

drop policy if exists appt_delete_pasien on public.appointments;
create policy appt_delete_pasien on public.appointments
  for delete to authenticated
  using (auth.uid() = pasien_id and status = 'terjadwal');


-- =====================================================================
-- 6. rekam_medis
-- =====================================================================
-- SELECT : pasien (lihat riwayatnya) + dokter (lihat semua kasus relevan).
-- ALL    : hanya dokter yang menangani (write/edit catatan).
drop policy if exists rm_select on public.rekam_medis;
create policy rm_select on public.rekam_medis
  for select to authenticated
  using (
    auth.uid() = pasien_id
    or auth.uid() = dokter_id
  );

drop policy if exists rm_manage_dokter on public.rekam_medis;
create policy rm_manage_dokter on public.rekam_medis
  for all to authenticated
  using (auth.uid() = dokter_id)
  with check (auth.uid() = dokter_id);


-- =====================================================================
-- 7. triage_kasus
-- =====================================================================
-- SELECT : pasien (kasus sendiri) + semua dokter.
-- INSERT : pasien lapor kasus sendiri.
-- UPDATE : dokter manage status & catatan.
drop policy if exists triage_select on public.triage_kasus;
create policy triage_select on public.triage_kasus
  for select to authenticated
  using (
    auth.uid() = pasien_id
    or public.current_user_role() = 'dokter'
  );

drop policy if exists triage_insert_pasien on public.triage_kasus;
create policy triage_insert_pasien on public.triage_kasus
  for insert to authenticated
  with check (auth.uid() = pasien_id);

drop policy if exists triage_update_dokter on public.triage_kasus;
create policy triage_update_dokter on public.triage_kasus
  for update to authenticated
  using (public.current_user_role() = 'dokter')
  with check (public.current_user_role() = 'dokter');


-- =====================================================================
-- 8. antrian
-- =====================================================================
-- SELECT : pasien (antrian via appointment-nya) + semua dokter.
-- ALL    : hanya dokter (manage queue).
drop policy if exists antrian_select on public.antrian;
create policy antrian_select on public.antrian
  for select to authenticated
  using (
    exists (
      select 1
      from public.appointments a
      where a.id = antrian.appointment_id
        and (a.pasien_id = auth.uid() or a.dokter_id = auth.uid())
    )
    or public.current_user_role() = 'dokter'
  );

drop policy if exists antrian_manage_dokter on public.antrian;
create policy antrian_manage_dokter on public.antrian
  for all to authenticated
  using (public.current_user_role() = 'dokter')
  with check (public.current_user_role() = 'dokter');


-- =====================================================================
-- 9. notifikasi
-- =====================================================================
-- SELECT/UPDATE : hanya milik user sendiri (untuk mark-as-read).
-- INSERT        : tidak ada policy untuk authenticated → notifikasi
--                 hanya bisa dibuat via service_role (backend job/cron).
--                 Kalau dokter/admin perlu kirim notif manual, tambah policy
--                 INSERT bersyarat current_user_role() = 'dokter'.
drop policy if exists notif_select_own on public.notifikasi;
create policy notif_select_own on public.notifikasi
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists notif_update_own on public.notifikasi;
create policy notif_update_own on public.notifikasi
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists notif_delete_own on public.notifikasi;
create policy notif_delete_own on public.notifikasi
  for delete to authenticated
  using (auth.uid() = user_id);


-- =====================================================================
-- DONE. Skema + RLS aktif. Lanjut: backend implementasikan endpoint nyata
-- yang query tabel-tabel ini, dan ganti stub di routes/*.ts.
-- =====================================================================
