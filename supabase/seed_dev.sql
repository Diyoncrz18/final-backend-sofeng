-- =====================================================================
-- seed_dev.sql
-- ---------------------------------------------------------------------
-- Sample data untuk DEVELOPMENT saja. JANGAN jalankan di production.
--
-- Cara pakai:
--   1. Buat user di Supabase Dashboard → Authentication → Users → Add user.
--      Isi email & password. Catat UUID yang dihasilkan.
--   2. Edit konstanta di awal file ini dengan UUID-UUID tersebut.
--   3. Paste & run di SQL Editor.
--
-- Default: SEMUA INSERT DI-COMMENT. Uncomment setelah ganti UUID.
-- =====================================================================


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ STEP 1 — Buat 4 user di Supabase Auth Dashboard, lalu isi UUID  │
-- │ di bawah ini. Trigger handle_new_user() akan auto-buat row di    │
-- │ profiles, jadi role di user_metadata harus benar.                │
-- └─────────────────────────────────────────────────────────────────┘

-- Contoh — ganti dengan UUID nyata:
--   Dokter 1 : drg.rina@klinikgigi.dev   role=dokter   UUID = ...
--   Dokter 2 : drg.andi@klinikgigi.dev   role=dokter   UUID = ...
--   Pasien 1 : ahmad@example.com         role=pasien   UUID = ...
--   Pasien 2 : kevin@example.com         role=pasien   UUID = ...


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ UNCOMMENT BLOK DI BAWAH SETELAH MENGGANTI UUID                  │
-- └─────────────────────────────────────────────────────────────────┘

/*

-- Variables (Postgres tidak support \set di PL/pgSQL biasa, jadi pakai DO block)
do $$
declare
  dokter1_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;  -- ganti
  dokter2_id uuid := '00000000-0000-0000-0000-000000000002'::uuid;  -- ganti
  pasien1_id uuid := '00000000-0000-0000-0000-000000000003'::uuid;  -- ganti
  pasien2_id uuid := '00000000-0000-0000-0000-000000000004'::uuid;  -- ganti
  appt1_id   uuid;
begin

  -- ===== Update role di profiles (kalau handle_new_user gagal set) =====
  update public.profiles set role = 'dokter', full_name = 'Dr. Rina Santoso' where id = dokter1_id;
  update public.profiles set role = 'dokter', full_name = 'Dr. Andi Pratama' where id = dokter2_id;
  update public.profiles set role = 'pasien', full_name = 'Ahmad Surya'      where id = pasien1_id;
  update public.profiles set role = 'pasien', full_name = 'Kevin Andhika'    where id = pasien2_id;

  -- ===== dokter_profiles =====
  insert into public.dokter_profiles (id, nip, sip, spesialisasi, rating, bio, pengalaman_tahun)
  values
    (dokter1_id, 'NIP001', 'SIP-2020-001', 'Konservasi Gigi (Sp.KG)', 4.9, 'Dokter gigi spesialis konservasi.', 8),
    (dokter2_id, 'NIP002', 'SIP-2021-002', 'Ortodonti (Sp.Ort)',       4.8, 'Spesialis kawat gigi & maloklusi.', 6)
  on conflict (id) do nothing;

  -- ===== jadwal_dokter (Senin-Jumat) =====
  insert into public.jadwal_dokter (dokter_id, hari, jam_mulai, jam_selesai, kuota)
  select dokter1_id, h, '08:00'::time, '16:00'::time, 12 from generate_series(1,5) as h
  on conflict do nothing;

  insert into public.jadwal_dokter (dokter_id, hari, jam_mulai, jam_selesai, kuota)
  select dokter2_id, h, '09:00'::time, '17:00'::time, 10 from generate_series(1,5) as h
  on conflict do nothing;

  -- ===== pasien_profiles =====
  insert into public.pasien_profiles (id, no_rm, tanggal_lahir, jenis_kelamin, alamat, golongan_darah)
  values
    (pasien1_id, 'RM-2023-0891', '1990-05-15', 'L', 'Jl. Merdeka No. 1, Jakarta',  'B+'),
    (pasien2_id, 'RM-2023-0892', '1995-08-22', 'L', 'Jl. Sudirman No. 45, Jakarta', 'O+')
  on conflict (id) do nothing;

  -- ===== appointments =====
  insert into public.appointments (pasien_id, dokter_id, tanggal, jam, jenis, status, keluhan)
  values
    (pasien1_id, dokter1_id, current_date + 1, '09:00'::time, 'pemeriksaan', 'terjadwal', 'Pembersihan karang gigi rutin')
  returning id into appt1_id;

  insert into public.appointments (pasien_id, dokter_id, tanggal, jam, jenis, status, keluhan)
  values
    (pasien2_id, dokter2_id, current_date + 2, '10:30'::time, 'kontrol',     'terjadwal', 'Kontrol kawat gigi bulanan');

  -- ===== rekam_medis (riwayat kunjungan lalu) =====
  insert into public.rekam_medis (pasien_id, dokter_id, tanggal, diagnosa, tindakan, biaya, catatan)
  values
    (pasien1_id, dokter1_id, current_date - 30, 'Karies gigi 36',
     'Tambal komposit', 350000.00, 'Pasien diminta kontrol 1 bulan'),
    (pasien1_id, dokter1_id, current_date - 90, 'Pembersihan karang gigi',
     'Scaling ultrasonic', 250000.00, 'Karang gigi sedang, perlu rutin 6 bulan');

  -- ===== triage_kasus (1 contoh kasus darurat) =====
  insert into public.triage_kasus (pasien_id, level, gejala, status)
  values
    (pasien2_id, 'kuning', 'Sakit gigi parah malam hari, gusi bengkak.', 'terbuka');

  -- ===== antrian untuk appointment hari ini (kalau ada) =====
  insert into public.antrian (appointment_id, nomor, status, estimasi_jam)
  values (appt1_id, 1, 'menunggu', '09:00'::time)
  on conflict (appointment_id) do nothing;

  -- ===== notifikasi =====
  insert into public.notifikasi (user_id, type, title, description)
  values
    (pasien1_id, 'pengingat', 'Pengingat Jadwal',
     'Jadwal pemeriksaan Anda besok pukul 09:00 WIB.'),
    (pasien2_id, 'konfirmasi', 'Booking Berhasil',
     'Booking kontrol kawat gigi pada lusa pukul 10:30 WIB telah dikonfirmasi.');

end;
$$;

*/

-- =====================================================================
-- Untuk hapus seluruh data dev (rollback):
--
-- delete from public.notifikasi;
-- delete from public.antrian;
-- delete from public.triage_kasus;
-- delete from public.rekam_medis;
-- delete from public.appointments;
-- delete from public.jadwal_dokter;
-- delete from public.pasien_profiles;
-- delete from public.dokter_profiles;
-- (auth.users tidak dihapus otomatis — hapus manual via Dashboard)
-- =====================================================================
