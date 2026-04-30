import { Router } from "express";
import { z } from "zod";

import { supabaseAdmin } from "../config/supabase";
import { requireAuth } from "../middlewares/requireAuth";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";
import { getRole, getUserClient, getUserId, isPasien } from "../utils/db";

const router = Router();
router.use(requireAuth);

/* ──────────────────────────────────────────────────────────────────── */
/*  Const & schema                                                       */
/* ──────────────────────────────────────────────────────────────────── */
const APPOINTMENT_STATUS = [
  "terjadwal",
  "menunggu",
  "sedang_ditangani",
  "selesai",
  "dibatalkan",
  "tidak_hadir",
] as const;

const APPOINTMENT_TYPE = [
  "konsultasi",
  "pemeriksaan",
  "kontrol",
  "tindakan",
  "darurat",
] as const;

// Select shape ber-relasi: ambil nested profile pasien & dokter sekaligus
// supaya FE tidak perlu query lagi (1 round-trip per list).
const APPOINTMENT_SELECT = `
  id,
  pasien_id,
  dokter_id,
  tanggal,
  jam,
  jenis,
  status,
  keluhan,
  catatan_dokter,
  created_at,
  updated_at,
  pasien:pasien_profiles!appointments_pasien_id_fkey (
    id,
    profile:profiles!inner ( id, full_name, avatar_url )
  ),
  dokter:dokter_profiles!appointments_dokter_id_fkey (
    id,
    spesialisasi,
    profile:profiles!inner ( id, full_name, avatar_url )
  )
`;

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/appointments                                                */
/*  Daftar appointment user yang login.                                  */
/*  - Pasien    : appointment dimana pasien_id = uid (RLS enforce)       */
/*  - Dokter    : appointment dimana dokter_id = uid (RLS enforce)       */
/*  Query:                                                               */
/*    status=terjadwal,menunggu  → filter (CSV)                          */
/*    from=2026-01-01            → tanggal >= from                       */
/*    to=2026-12-31              → tanggal <= to                         */
/*    upcoming=1                 → tanggal >= today                      */
/* ──────────────────────────────────────────────────────────────────── */
const listQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    )
    .pipe(z.array(z.enum(APPOINTMENT_STATUS)).optional()),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  upcoming: z.enum(["0", "1"]).optional(),
});

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const params = listQuerySchema.parse(req.query);
    const role = getRole(req);
    if (!role) throw ApiError.forbidden("Role tidak diketahui");

    const client = getUserClient(req);
    let query = client
      .from("appointments")
      .select(APPOINTMENT_SELECT)
      .order("tanggal", { ascending: true })
      .order("jam", { ascending: true });

    if (params.status && params.status.length > 0) {
      query = query.in("status", params.status);
    }
    if (params.from) query = query.gte("tanggal", params.from);
    if (params.to) query = query.lte("tanggal", params.to);
    if (params.upcoming === "1") {
      query = query.gte("tanggal", new Date().toISOString().slice(0, 10));
    }

    const { data, error } = await query;
    if (error) throw ApiError.badRequest(`Gagal ambil appointment: ${error.message}`);

    res.json({ items: data ?? [] });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/appointments/:id                                            */
/*  Detail satu appointment.                                             */
/* ──────────────────────────────────────────────────────────────────── */
const idParamsSchema = z.object({
  id: z.string().uuid("ID appointment tidak valid"),
});

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const client = getUserClient(req);

    const { data, error } = await client
      .from("appointments")
      .select(APPOINTMENT_SELECT)
      .eq("id", id)
      .maybeSingle();

    if (error) throw ApiError.badRequest(`Gagal ambil appointment: ${error.message}`);
    if (!data) throw ApiError.notFound("Appointment tidak ditemukan");

    res.json({ appointment: data });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  POST /api/appointments                                               */
/*  Buat appointment baru. Hanya pasien.                                 */
/*  Body: { dokterId, tanggal, jam, jenis?, keluhan? }                   */
/* ──────────────────────────────────────────────────────────────────── */
const createSchema = z.object({
  dokterId: z.string().uuid("ID dokter tidak valid"),
  tanggal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format tanggal harus YYYY-MM-DD"),
  jam: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:\d{2})?$/, "Format jam harus HH:MM"),
  jenis: z.enum(APPOINTMENT_TYPE).default("konsultasi"),
  keluhan: z.string().max(500).optional().nullable(),
});

router.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!isPasien(req)) {
      throw ApiError.forbidden("Hanya pasien yang dapat membuat appointment");
    }
    const userId = getUserId(req);
    const body = createSchema.parse(req.body);

    // ── Validasi: tanggal tidak boleh masa lalu ─────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    if (body.tanggal < today) {
      throw ApiError.badRequest("Tanggal appointment tidak boleh di masa lalu");
    }

    // ── Validasi: dokter ada ────────────────────────────────────────────
    const { data: dokter, error: dErr } = await supabaseAdmin
      .from("dokter_profiles")
      .select("id")
      .eq("id", body.dokterId)
      .maybeSingle();
    if (dErr || !dokter) {
      throw ApiError.notFound("Dokter tidak ditemukan");
    }

    // ── Validasi: cek konflik (pasien sama, jam sama, masih terjadwal) ──
    const { data: conflict } = await supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("pasien_id", userId)
      .eq("tanggal", body.tanggal)
      .eq("jam", body.jam)
      .in("status", ["terjadwal", "menunggu", "sedang_ditangani"])
      .maybeSingle();
    if (conflict) {
      throw ApiError.conflict(
        "Anda sudah punya appointment di jam yang sama. Batalkan dulu sebelum buat baru.",
      );
    }

    // ── Pastikan pasien_profiles ada (auto-create kalau belum) ──────────
    await supabaseAdmin
      .from("pasien_profiles")
      .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });

    // ── Insert via user-scoped client supaya RLS aktif ──────────────────
    // Policy `appt_insert_pasien` mengecek pasien_id = auth.uid().
    const client = getUserClient(req);
    const { data: created, error: cErr } = await client
      .from("appointments")
      .insert({
        pasien_id: userId,
        dokter_id: body.dokterId,
        tanggal: body.tanggal,
        jam: body.jam,
        jenis: body.jenis,
        keluhan: body.keluhan ?? null,
        status: "terjadwal",
      })
      .select(APPOINTMENT_SELECT)
      .single();

    if (cErr || !created) {
      throw ApiError.badRequest(`Gagal buat appointment: ${cErr?.message ?? "unknown"}`);
    }

    res.status(201).json({ appointment: created });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  POST /api/appointments/:id/cancel                                    */
/*  Cancel appointment. Pasien (pemilik) atau dokter (penanganan).       */
/*  Pakai service_role karena pasien tidak punya policy UPDATE pasca-0003*/
/*  Validasi business: status saat ini harus 'terjadwal' atau 'menunggu' */
/* ──────────────────────────────────────────────────────────────────── */
const cancelSchema = z.object({
  alasan: z.string().max(300).optional().nullable(),
});

router.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = cancelSchema.parse(req.body ?? {});
    const userId = getUserId(req);

    // Ambil appointment dengan service_role (bypass RLS supaya error
    // message lebih jelas — kalau pakai user client, response NULL kalau
    // bukan owner, tidak bisa dibedakan dari "tidak ada").
    const { data: appt, error: aErr } = await supabaseAdmin
      .from("appointments")
      .select("id, pasien_id, dokter_id, status, tanggal, jam, catatan_dokter")
      .eq("id", id)
      .maybeSingle();

    if (aErr) throw ApiError.badRequest(`Gagal ambil appointment: ${aErr.message}`);
    if (!appt) throw ApiError.notFound("Appointment tidak ditemukan");

    // ── Authorization ──────────────────────────────────────────────────
    const isOwner = appt.pasien_id === userId;
    const isAssigned = appt.dokter_id === userId;
    if (!isOwner && !isAssigned) {
      throw ApiError.forbidden("Anda tidak berwenang membatalkan appointment ini");
    }

    // ── Business rule: hanya status awal yang boleh cancel ─────────────
    const cancellableStatus = ["terjadwal", "menunggu"];
    if (!cancellableStatus.includes(appt.status)) {
      throw ApiError.unprocessable(
        `Appointment dengan status "${appt.status}" tidak bisa dibatalkan.`,
      );
    }

    // ── Update status. Append alasan ke catatan_dokter (audit trail) ──
    const auditNote = body.alasan
      ? `[Dibatalkan oleh ${isOwner ? "pasien" : "dokter"}] ${body.alasan}`
      : `[Dibatalkan oleh ${isOwner ? "pasien" : "dokter"}]`;

    const newCatatan = appt.catatan_dokter
      ? `${appt.catatan_dokter}\n${auditNote}`
      : auditNote;

    const { data: updated, error: uErr } = await supabaseAdmin
      .from("appointments")
      .update({
        status: "dibatalkan",
        catatan_dokter: newCatatan,
      })
      .eq("id", id)
      .select(APPOINTMENT_SELECT)
      .single();

    if (uErr || !updated) {
      throw ApiError.internal(`Gagal cancel appointment: ${uErr?.message ?? "unknown"}`);
    }

    res.json({ appointment: updated });
  }),
);

export default router;
