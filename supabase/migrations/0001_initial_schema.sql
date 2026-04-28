-- =====================================================================
-- 0001_initial_schema.sql
-- ---------------------------------------------------------------------
-- Klinik Gigi — Initial database schema (extensions, ENUMs, tables,
-- indexes, dan triggers).
--
-- TARGET   : Supabase (Postgres 15+) — pakai Dashboard SQL Editor atau
--            `supabase db push` via CLI.
-- ORDER    : Jalankan SETELAH project Supabase fresh dibuat. RLS policies
--            ada di file 0002_rls_policies.sql (jalankan setelah ini).
-- IDEMPOTEN: Aman dijalankan ulang (semua DDL pakai IF NOT EXISTS atau
--            DO-block guard).
-- =====================================================================


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ 1. EXTENSIONS                                                    │
-- └─────────────────────────────────────────────────────────────────┘
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ 2. ENUMS                                                         │
-- └─────────────────────────────────────────────────────────────────┘
do $$ begin
  create type public.user_role as enum ('pasien', 'dokter');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.appointment_status as enum (
    'terjadwal', 'menunggu', 'sedang_ditangani', 'selesai',
    'dibatalkan', 'tidak_hadir'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.appointment_type as enum (
    'konsultasi', 'pemeriksaan', 'kontrol', 'tindakan', 'darurat'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.triage_level as enum ('hijau', 'kuning', 'merah');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.triage_status as enum (
    'terbuka', 'sedang_ditangani', 'selesai'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.antrian_status as enum (
    'menunggu', 'dipanggil', 'sedang_ditangani', 'selesai', 'dilewati'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notifikasi_type as enum (
    'pengingat', 'konfirmasi', 'pengumuman', 'darurat', 'lainnya'
  );
exception when duplicate_object then null; end $$;


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ 3. TABLES                                                        │
-- └─────────────────────────────────────────────────────────────────┘

-- 3.1 profiles
-- ────────────
-- Tabel inti yang extends auth.users. Setiap user (pasien/dokter)
-- pasti punya 1 row di sini. Auto-created via trigger on auth.users insert.
create table if not exists public.profiles (
  id            uuid        primary key references auth.users(id) on delete cascade,
  full_name     text        not null,
  role          public.user_role not null default 'pasien',
  email         text,
  phone         text,
  avatar_url    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table  public.profiles is 'Profil user gabungan (pasien & dokter), extends auth.users.';
comment on column public.profiles.role is 'Diisi dari user_metadata.role saat register, default pasien.';


-- 3.2 pasien_profiles
-- ───────────────────
-- Data tambahan khusus pasien.
create table if not exists public.pasien_profiles (
  id              uuid        primary key references public.profiles(id) on delete cascade,
  no_rm           text        unique,
  tanggal_lahir   date,
  jenis_kelamin   text        check (jenis_kelamin in ('L', 'P')),
  alamat          text,
  golongan_darah  text        check (golongan_darah in ('A', 'B', 'AB', 'O', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  riwayat_alergi  text,
  catatan_medis   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.pasien_profiles is 'Data klinis tambahan pasien. id == profiles.id == auth.users.id.';


-- 3.3 dokter_profiles
-- ───────────────────
-- Data tambahan khusus dokter.
create table if not exists public.dokter_profiles (
  id                  uuid        primary key references public.profiles(id) on delete cascade,
  nip                 text        unique,
  sip                 text,                  -- Surat Ijin Praktik
  spesialisasi        text        not null,  -- mis. 'Konservasi Gigi', 'Ortodonti', 'Bedah Mulut'
  rating              numeric(3,2) default 0 check (rating between 0 and 5),
  bio                 text,
  pengalaman_tahun    int         default 0 check (pengalaman_tahun >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.dokter_profiles is 'Data praktik dokter. id == profiles.id == auth.users.id.';


-- 3.4 jadwal_dokter
-- ─────────────────
-- Slot kerja rutin dokter per hari dalam seminggu (recurring).
create table if not exists public.jadwal_dokter (
  id            uuid        primary key default gen_random_uuid(),
  dokter_id     uuid        not null references public.dokter_profiles(id) on delete cascade,
  hari          smallint    not null check (hari between 0 and 6),  -- 0=Minggu, 6=Sabtu
  jam_mulai     time        not null,
  jam_selesai   time        not null,
  kuota         int         not null default 10 check (kuota > 0),
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (jam_selesai > jam_mulai)
);

comment on column public.jadwal_dokter.hari is '0=Minggu, 1=Senin, ..., 6=Sabtu';


-- 3.5 appointments
-- ────────────────
-- Janji temu pasien dengan dokter pada tanggal & jam spesifik.
create table if not exists public.appointments (
  id                uuid        primary key default gen_random_uuid(),
  pasien_id         uuid        not null references public.pasien_profiles(id) on delete cascade,
  dokter_id         uuid        not null references public.dokter_profiles(id) on delete restrict,
  tanggal           date        not null,
  jam               time        not null,
  jenis             public.appointment_type   not null default 'konsultasi',
  status            public.appointment_status not null default 'terjadwal',
  keluhan           text,                       -- diisi pasien saat booking
  catatan_dokter    text,                       -- diisi dokter pasca-pemeriksaan
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.appointments is 'Janji temu. pasien_id & dokter_id mengarah ke *_profiles, BUKAN auth.users.';


-- 3.6 rekam_medis
-- ───────────────
-- Catatan medis hasil pemeriksaan (1 appointment dapat menghasilkan 1+ rekam_medis).
create table if not exists public.rekam_medis (
  id                uuid        primary key default gen_random_uuid(),
  pasien_id         uuid        not null references public.pasien_profiles(id) on delete cascade,
  dokter_id         uuid        not null references public.dokter_profiles(id) on delete restrict,
  appointment_id    uuid        references public.appointments(id) on delete set null,
  tanggal           date        not null default current_date,
  diagnosa          text        not null,
  tindakan          text,
  resep             text,
  biaya             numeric(12,2) default 0 check (biaya >= 0),
  catatan           text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);


-- 3.7 triage_kasus
-- ────────────────
-- Kasus darurat yang dilaporkan pasien atau diidentifikasi dokter di klinik.
create table if not exists public.triage_kasus (
  id                    uuid        primary key default gen_random_uuid(),
  pasien_id             uuid        not null references public.pasien_profiles(id) on delete cascade,
  dokter_id             uuid        references public.dokter_profiles(id) on delete set null,
  level                 public.triage_level  not null,
  gejala                text        not null,
  status                public.triage_status not null default 'terbuka',
  catatan_penanganan    text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);


-- 3.8 antrian
-- ───────────
-- Nomor antrian real-time untuk appointment hari ini. 1 appointment = 1 row antrian.
create table if not exists public.antrian (
  id                uuid        primary key default gen_random_uuid(),
  appointment_id    uuid        not null unique references public.appointments(id) on delete cascade,
  nomor             int         not null check (nomor > 0),
  status            public.antrian_status not null default 'menunggu',
  estimasi_jam      time,
  dipanggil_at      timestamptz,
  selesai_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);


-- 3.9 notifikasi
-- ──────────────
-- Notifikasi yang ditujukan ke 1 user. Dibuat oleh sistem (service_role) atau dokter.
create table if not exists public.notifikasi (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references public.profiles(id) on delete cascade,
  type          public.notifikasi_type not null default 'lainnya',
  title         text        not null,
  description   text,
  link          text,                          -- deep link ke halaman terkait
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ 4. INDEXES                                                       │
-- └─────────────────────────────────────────────────────────────────┘

-- profiles: lookup by role (untuk listing dokter publik)
create index if not exists idx_profiles_role
  on public.profiles(role);

-- appointments: query umum (riwayat pasien, agenda dokter, filter status)
create index if not exists idx_appointments_pasien_tanggal
  on public.appointments(pasien_id, tanggal desc);
create index if not exists idx_appointments_dokter_tanggal
  on public.appointments(dokter_id, tanggal desc);
create index if not exists idx_appointments_status
  on public.appointments(status);
create index if not exists idx_appointments_tanggal
  on public.appointments(tanggal);

-- rekam_medis: riwayat per pasien
create index if not exists idx_rm_pasien_tanggal
  on public.rekam_medis(pasien_id, tanggal desc);
create index if not exists idx_rm_dokter
  on public.rekam_medis(dokter_id);

-- triage: prioritas berdasarkan status & level
create index if not exists idx_triage_status_level
  on public.triage_kasus(status, level);
create index if not exists idx_triage_pasien
  on public.triage_kasus(pasien_id);

-- antrian: scan harian
create index if not exists idx_antrian_status
  on public.antrian(status);

-- notifikasi: feed user + filter unread
create index if not exists idx_notif_user
  on public.notifikasi(user_id, created_at desc);
create index if not exists idx_notif_user_unread
  on public.notifikasi(user_id, created_at desc)
  where read_at is null;

-- jadwal_dokter: lookup per dokter
create index if not exists idx_jadwal_dokter
  on public.jadwal_dokter(dokter_id, hari)
  where is_active;


-- ┌─────────────────────────────────────────────────────────────────┐
-- │ 5. TRIGGERS                                                      │
-- └─────────────────────────────────────────────────────────────────┘

-- 5.1 set_updated_at()
-- ────────────────────
-- Auto-update kolom updated_at setiap UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Pasang ke semua tabel yang punya kolom updated_at
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'profiles', 'pasien_profiles', 'dokter_profiles', 'jadwal_dokter',
      'appointments', 'rekam_medis', 'triage_kasus', 'antrian'
    ])
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at
         before update on public.%I
         for each row execute function public.set_updated_at()',
      t
    );
  end loop;
end;
$$;


-- 5.2 handle_new_user()
-- ─────────────────────
-- Auto-create profiles row ketika user baru terdaftar di auth.users.
-- Ambil full_name & role dari raw_user_meta_data (di-set frontend/backend
-- saat signUp / admin.createUser).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role, email)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      split_part(new.email, '@', 1)
    ),
    coalesce(
      (new.raw_user_meta_data->>'role')::public.user_role,
      'pasien'::public.user_role
    ),
    new.email
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =====================================================================
-- DONE. Lanjut ke 0002_rls_policies.sql untuk Row Level Security.
-- =====================================================================
