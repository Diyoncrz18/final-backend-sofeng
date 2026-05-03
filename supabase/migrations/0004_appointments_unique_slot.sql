-- =====================================================================
-- 0004_appointments_unique_slot.sql
-- ---------------------------------------------------------------------
-- Hard-guarantee: 1 dokter tidak bisa punya 2 appointment di slot yang
-- sama (tanggal + jam) selama statusnya masih aktif.
--
-- Tanpa constraint ini, dua pasien bisa book ke dokter yang sama di jam
-- yang sama (race condition di endpoint POST /api/appointments).
--
-- PRASYARAT : 0001 sudah dijalankan.
-- IDEMPOTEN : Aman dijalankan ulang.
-- =====================================================================

-- Catatan: pakai PARTIAL unique index, bukan unique constraint penuh,
-- supaya appointment yang dibatalkan / selesai TIDAK menghalangi slot
-- yang sama dipakai lagi (mis. kalau pasien lama cancel jam 09:00,
-- pasien baru tetap boleh book jam 09:00).
--
-- Status yang dianggap "menahan slot":
--   • terjadwal         — booking aktif belum dimulai
--   • menunggu          — pasien sudah check-in, antri panggilan
--   • sedang_ditangani  — sedang diperiksa
-- Status pasif (selesai, dibatalkan, tidak_hadir) → slot bebas lagi.

drop index if exists public.uniq_dokter_slot_active;

create unique index uniq_dokter_slot_active
  on public.appointments(dokter_id, tanggal, jam)
  where status in ('terjadwal', 'menunggu', 'sedang_ditangani');

comment on index public.uniq_dokter_slot_active is
  'Mencegah double-booking: 1 dokter hanya bisa punya 1 appointment aktif per slot (tanggal+jam). Status pasif dikecualikan agar slot bisa dipakai ulang setelah cancel/no-show.';
