-- =====================================================================
-- 0003_fix_rls_and_harden_trigger.sql
-- ---------------------------------------------------------------------
-- Bug fixes untuk migration 0002 (RLS) dan 0001 (trigger handle_new_user).
--
-- PRASYARAT : 0001 dan 0002 sudah dijalankan.
-- IDEMPOTEN : Aman dijalankan ulang (drop+recreate semua object).
--
-- Bug yang diperbaiki:
--   1. profiles_select — dokter tidak bisa SELECT row pasien (hanya row dokter).
--      Akibatnya: dashboard dokter tidak bisa tampilkan nama/email pasien.
--   2. appt_update — pasien bisa update kolom apa pun (mis. mark `selesai`
--      sendiri tanpa pernah datang). Audit trail medis rusak.
--   3. handle_new_user — trigger bisa fail karena cast role yang invalid
--      atau email NULL, menyebabkan user yatim di auth.users tanpa profiles.
-- =====================================================================


-- =====================================================================
-- Fix #1: profiles_select
-- ---------------------------------------------------------------------
-- Sebelum  : auth.uid() = id OR role = 'dokter'
--            → pasien hanya bisa lihat dirinya + profil dokter (OK).
--            → dokter hanya bisa lihat dirinya + profil dokter lain.
--              Tidak bisa lihat profil pasien sama sekali. ❌
--
-- Sesudah  : tambah branch `current_user_role() = 'dokter'` agar dokter
--            bisa SELECT semua profil (termasuk pasien) untuk listing
--            appointment, search pasien, EHR, dll.
-- =====================================================================
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    auth.uid() = id
    or role = 'dokter'                            -- semua orang lihat dokter
    or public.current_user_role() = 'dokter'      -- dokter lihat semua user
  );


-- =====================================================================
-- Fix #2: appointments_update
-- ---------------------------------------------------------------------
-- Sebelum  : pasien & dokter sama-sama bisa update SEMUA kolom.
--            Pasien bisa set status='selesai' atau ubah dokter_id. ❌
--
-- Sesudah  : split jadi 2 policy:
--            • appt_update_dokter — dokter update appointment yang
--              dia tangani.
--            • (pasien TIDAK punya policy UPDATE) — semua perubahan
--              pasien wajib lewat endpoint backend khusus (mis.
--              POST /api/appointments/:id/cancel) yang validasi
--              business rule + pakai service_role atau dengan trigger
--              yang membatasi kolom yang boleh berubah.
--
-- Cancel oleh pasien: lewat endpoint backend yang set status='dibatalkan'
-- pakai service_role setelah validasi (status awal harus 'terjadwal',
-- minimal H-24 jam, dll).
-- =====================================================================
drop policy if exists appt_update on public.appointments;
drop policy if exists appt_update_dokter on public.appointments;

create policy appt_update_dokter on public.appointments
  for update to authenticated
  using (auth.uid() = dokter_id)
  with check (auth.uid() = dokter_id);


-- =====================================================================
-- Fix #3: harden handle_new_user trigger
-- ---------------------------------------------------------------------
-- Sebelum  : (raw_user_meta_data->>'role')::user_role
--            → exception kalau role string invalid (mis. 'admin').
--            split_part(NULL, '@', 1) → NULL → violate full_name NOT NULL.
--
-- Sesudah  :
--   • Validasi role text dulu sebelum cast → pesan error yang jelas
--     atau default ke 'pasien' kalau missing.
--   • Triple-fallback untuk full_name: metadata → email prefix →
--     placeholder dari UUID. Tidak pernah NULL.
--   • Tetap raise exception kalau role text non-empty tapi bukan enum
--     valid → user creation dirollback (cleaner daripada user yatim).
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role       public.user_role;
  v_role_text  text;
  v_full_name  text;
begin
  -- ── Resolve role ──────────────────────────────────────────────────
  v_role_text := nullif(trim(new.raw_user_meta_data->>'role'), '');

  if v_role_text is null then
    v_role := 'pasien'::public.user_role;
  elsif v_role_text in ('pasien', 'dokter') then
    v_role := v_role_text::public.user_role;
  else
    raise exception
      'Role "%" tidak valid. Hanya "pasien" atau "dokter".', v_role_text
      using errcode = '22023';  -- invalid_parameter_value
  end if;

  -- ── Resolve full_name (jamin NOT NULL) ────────────────────────────
  v_full_name := coalesce(
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'User ' || substr(new.id::text, 1, 8)
  );

  -- ── Insert profile ────────────────────────────────────────────────
  insert into public.profiles (id, full_name, role, email)
  values (new.id, v_full_name, v_role, new.email)
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user is
  'Auto-create profile saat user baru di auth.users. '
  'Versi 0003: validasi role enum + fallback full_name yang anti-NULL.';


-- =====================================================================
-- DONE. RLS dokter sudah bisa lihat pasien, pasien tidak bisa update
-- appointment via RLS, trigger tahan banting.
-- =====================================================================
