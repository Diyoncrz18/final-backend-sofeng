# Skema Optimasi Jadwal

Dokumen ini merangkum struktur data yang diperlukan agar halaman Optimasi Jadwal memakai data nyata dan tetap siap dikembangkan.

## Tabel Inti Yang Dipakai Sekarang

### `jadwal_dokter`

Menyimpan jam praktik rutin dokter per hari dalam seminggu.

| Kolom | Tipe | Fungsi |
| --- | --- | --- |
| `id` | `uuid` | Primary key jadwal |
| `dokter_id` | `uuid` | Relasi ke `dokter_profiles.id` |
| `hari` | `smallint` | 0 Minggu sampai 6 Sabtu |
| `jam_mulai` | `time` | Awal jam praktik |
| `jam_selesai` | `time` | Akhir jam praktik |
| `kuota` | `int` | Kapasitas pasien pada blok praktik |
| `is_active` | `boolean` | Status aktif/nonaktif jadwal |
| `created_at`, `updated_at` | `timestamptz` | Audit timestamp |

### `appointments`

Menyimpan booking aktual pasien pada tanggal dan jam spesifik.

| Kolom | Tipe | Fungsi |
| --- | --- | --- |
| `id` | `uuid` | Primary key appointment |
| `pasien_id` | `uuid` | Relasi ke pasien |
| `dokter_id` | `uuid` | Relasi ke dokter |
| `tanggal` | `date` | Tanggal kunjungan |
| `jam` | `time` | Jam mulai kunjungan |
| `jenis` | `appointment_type` | Konsultasi, pemeriksaan, kontrol, tindakan, darurat |
| `status` | `appointment_status` | Terjadwal, menunggu, sedang ditangani, selesai, dibatalkan, tidak hadir |
| `keluhan` | `text` | Keluhan dari pasien |
| `catatan_dokter` | `text` | Catatan dokter setelah pemeriksaan |

Index penting yang sudah ada:

- `idx_jadwal_dokter(dokter_id, hari)`
- `idx_appointments_dokter_tanggal(dokter_id, tanggal desc)`
- `uniq_dokter_slot_active(dokter_id, tanggal, jam)` untuk mencegah double booking aktif.

## Tabel Lanjutan Yang Disarankan

Belum wajib untuk UI saat ini, tetapi dibutuhkan bila optimasi jadwal ingin menangani libur, rapat, cuti, reschedule otomatis, dan rekomendasi kapasitas yang lebih akurat.

### `jadwal_blokir`

Untuk menyimpan blok waktu yang tidak bisa dipakai meski berada di dalam jam praktik rutin.

| Kolom | Tipe |
| --- | --- |
| `id` | `uuid primary key` |
| `dokter_id` | `uuid references dokter_profiles(id)` |
| `tanggal` | `date not null` |
| `jam_mulai` | `time not null` |
| `jam_selesai` | `time not null` |
| `alasan` | `text` |
| `created_at`, `updated_at` | `timestamptz` |

### `appointment_duration_rules`

Untuk mengatur durasi per jenis tindakan, menggantikan estimasi statis di frontend.

| Kolom | Tipe |
| --- | --- |
| `jenis` | `appointment_type primary key` |
| `durasi_menit` | `int not null` |
| `buffer_menit` | `int default 0` |

### `jadwal_rekomendasi`

Untuk menyimpan hasil rekomendasi scheduler bila nantinya memakai engine optimasi server-side.

| Kolom | Tipe |
| --- | --- |
| `id` | `uuid primary key` |
| `dokter_id` | `uuid references dokter_profiles(id)` |
| `appointment_id` | `uuid references appointments(id)` |
| `tipe` | `text` |
| `pesan` | `text` |
| `status` | `text` |
| `created_at` | `timestamptz` |
