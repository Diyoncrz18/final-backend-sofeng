# backend-klinik-sofeng

REST API service untuk aplikasi **Klinik Gigi** (tugas Software Engineering).
Frontend: [`../klinik-sofeng`](../klinik-sofeng) (Next.js 16 App Router).

Stack: **Node.js + TypeScript + Express 4 + Supabase** (Postgres + Auth).

---

## 1. Prasyarat

| Tools     | Versi minimum         |
| --------- | --------------------- |
| Node.js   | `>=20.0.0` (uji: 24)  |
| npm       | `>=10` (atau pnpm/yarn) |
| Supabase  | Project aktif         |

> Verifikasi: `node --version && npm --version`

---

## 2. Setup awal

```bash
# 1. masuk ke folder backend
cd backend-klinik-sofeng

# 2. install dependencies
npm install

# 3. salin template env, lalu isi nilainya
copy .env.example .env        # Windows (cmd / PowerShell)
# cp  .env.example .env       # macOS / Linux

# 4. jalankan dev server (auto-restart via tsx watch)
npm run dev
```

Server akan listen di `http://localhost:4000` secara default. Cek:

```bash
curl http://localhost:4000/api/health
```

Response:

```json
{
  "status": "ok",
  "service": "backend-klinik-sofeng",
  "timestamp": "2026-04-27T13:00:00.000Z",
  "uptime": 1.234
}
```

---

## 3. Environment variables

Lihat [`.env.example`](./.env.example) untuk template lengkap.

| Variable                    | Wajib | Keterangan                                                                  |
| --------------------------- | :---: | --------------------------------------------------------------------------- |
| `NODE_ENV`                  |       | `development` (default) / `test` / `production`                             |
| `PORT`                      |       | Default `4000`                                                              |
| `ALLOWED_ORIGINS`           |       | Daftar origin yang diizinkan CORS, dipisah koma. Default `http://localhost:3000` |
| `SUPABASE_URL`              |   ✅  | Project URL Supabase, mis. `https://xxxx.supabase.co`                       |
| `SUPABASE_ANON_KEY`         |   ✅  | Anon (public) key, dipakai untuk per-user client (RLS)                      |
| `SUPABASE_SERVICE_ROLE_KEY` |   ✅  | **Server-only.** JANGAN expose ke frontend. Bypass RLS.                     |

> Cara dapat: Supabase Dashboard → **Project Settings → API**.

---

## 4. Scripts npm

| Script              | Fungsi                                                |
| ------------------- | ----------------------------------------------------- |
| `npm run dev`       | Jalankan dev server dengan hot reload (`tsx watch`)   |
| `npm run build`     | Compile TypeScript → `dist/`                          |
| `npm start`         | Jalankan hasil build (`node dist/server.js`)          |
| `npm run type-check`| Cek error TypeScript tanpa emit                       |
| `npm run clean`     | Hapus folder `dist/`                                  |

---

## 5. Struktur folder

```
backend-klinik-sofeng/
├── src/
│   ├── config/
│   │   ├── env.ts              ← validasi env via zod
│   │   └── supabase.ts         ← supabaseAdmin + createSupabaseUserClient
│   ├── middlewares/
│   │   ├── errorHandler.ts     ← global error → JSON
│   │   ├── notFound.ts         ← 404 handler
│   │   └── requireAuth.ts      ← verifikasi JWT Supabase
│   ├── routes/
│   │   ├── index.ts            ← aggregator (/api)
│   │   ├── health.routes.ts    ← /api/health
│   │   ├── auth.routes.ts      ← /api/auth/{login,register,me,logout}
│   │   ├── pasien.routes.ts    ← /api/pasien/*
│   │   └── appointment.routes.ts ← /api/appointments/*
│   ├── types/
│   │   └── express.d.ts        ← augment Request.user
│   ├── utils/
│   │   ├── ApiError.ts         ← typed HTTP error
│   │   └── asyncHandler.ts     ← wrap async handler
│   ├── app.ts                  ← bootstrap Express (middlewares + routes)
│   └── server.ts               ← entry point (listen + graceful shutdown)
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## 6. Endpoint yang sudah disediakan

Base URL: `http://localhost:4000/api`

| Method | Path               | Auth | Keterangan                                          |
| ------ | ------------------ | :--: | --------------------------------------------------- |
| GET    | `/health`          |  —   | Liveness probe                                       |
| POST   | `/auth/register`   |  —   | Buat user baru. Body: `{ email, password, fullName, role }` |
| POST   | `/auth/login`      |  —   | Login. Body: `{ email, password }`. Response: `{ user, session }` |
| GET    | `/auth/me`         |  ✅  | User dari token saat ini                             |
| POST   | `/auth/logout`     |  ✅  | Revoke session                                       |
| GET    | `/pasien/me`       |  ✅  | Stub profil pasien                                   |
| GET    | `/appointments`    |  ✅  | Stub list appointment                                |
| POST   | `/appointments`    |  ✅  | Stub create appointment (501)                        |

> Endpoint berlabel ✅ butuh header `Authorization: Bearer <access_token>` (didapat dari `/auth/login`).

---

## 7. Pola pemakaian Supabase

Backend ini punya **dua jenis client**:

1. **`supabaseAdmin`** — `SERVICE_ROLE` key, bypass RLS.
   Untuk operasi admin: createUser, listUsers, write tabel sistem, cron jobs.
   **JANGAN pernah dikirim ke browser.**

2. **`createSupabaseUserClient(accessToken)`** — anon key + JWT user.
   Untuk operasi data user (select profil sendiri, insert appointment).
   RLS aktif sebagai user → otorisasi otomatis di level database.

```ts
// contoh di route
import { createSupabaseUserClient } from "@/config/supabase";

router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const sb = createSupabaseUserClient(req.accessToken!);
  const { data, error } = await sb
    .from("pasien_profiles")
    .select("*")
    .single();

  if (error) throw ApiError.internal(error.message);
  res.json({ profile: data });
}));
```

---

## 8. Integrasi dengan frontend (Next.js)

Frontend di `../klinik-sofeng` perlu tahu base URL backend ini.

Tambahkan ke `klinik-sofeng/.env.local`:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api
```

Contoh fetch dari frontend:

```ts
const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const { session } = await res.json();
// simpan session.access_token (cookie httpOnly atau secure storage)
```

Untuk endpoint protected, kirim token:

```ts
fetch(`${API}/auth/me`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
```

---

## 9. Roadmap (next steps)

- [ ] Buat skema tabel di Supabase: `pasien_profiles`, `appointments`, `dokter_profiles`, `rekam_medis`, dll.
- [ ] Aktifkan RLS + policy per tabel.
- [ ] Lengkapi controller `/pasien/me`, `/appointments` (CRUD).
- [ ] Tambah modul: `/dokter`, `/jadwal`, `/triage`, `/rekam-medis`.
- [ ] Rate limiting (mis. `express-rate-limit`) untuk endpoint auth.
- [ ] Logging terstruktur (mis. `pino`) di production.
- [ ] Test suite (vitest + supertest).
- [ ] CI lint + type-check.

---

## 10. Troubleshooting

**`Environment variables tidak valid`** saat start:
- Pastikan `.env` ada dan semua key wajib terisi.
- `SUPABASE_URL` harus URL valid (`https://...`).
- `*_KEY` minimal 20 karakter (default Supabase ~ ratusan karakter).

**`Cannot find module 'express'`** di IDE:
- Jalankan `npm install` dulu.

**CORS error dari frontend:**
- Tambahkan origin frontend ke `ALLOWED_ORIGINS` (pisah koma).

---

© Klinik Gigi — Software Engineering coursework.
