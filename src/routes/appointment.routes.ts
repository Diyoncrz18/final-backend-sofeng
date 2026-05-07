import { Router } from "express";
import { z } from "zod";

import { supabaseAdmin } from "../config/supabase";
import { requireAuth } from "../middlewares/requireAuth";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";
import { getRole, getUserClient, getUserId, isDokter, isPasien } from "../utils/db";

const router = Router();

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

const REKAM_MEDIS_SELECT = `
  id,
  pasien_id,
  dokter_id,
  appointment_id,
  tanggal,
  diagnosa,
  tindakan,
  resep,
  biaya,
  catatan,
  created_at,
  updated_at
`;

const idParamsSchema = z.object({
  id: z.string().uuid("ID appointment tidak valid"),
});

async function createNotification(input: {
  userId: string;
  type: "pengingat" | "konfirmasi" | "pengumuman" | "darurat" | "lainnya";
  title: string;
  description?: string | null;
  link?: string | null;
}) {
  const { error } = await supabaseAdmin.from("notifikasi").insert({
    user_id: input.userId,
    type: input.type,
    title: input.title,
    description: input.description ?? null,
    link: input.link ?? null,
  });

  if (error) {
    console.error("[notifikasi] gagal membuat notifikasi:", error.message);
  }
}

function getAppointmentPatientName(appointment: unknown): string {
  const pasienValue = (appointment as { pasien?: unknown }).pasien;
  const pasien = Array.isArray(pasienValue) ? pasienValue[0] : pasienValue;
  const profileValue = (pasien as { profile?: unknown } | null | undefined)?.profile;
  const profile = Array.isArray(profileValue) ? profileValue[0] : profileValue;
  const fullName = (profile as { full_name?: unknown } | null | undefined)?.full_name;

  return typeof fullName === "string" && fullName.trim() ? fullName.trim() : "Pasien";
}

async function getAppointmentQueue(appointmentId: string) {
  const { data, error } = await supabaseAdmin
    .from("antrian")
    .select("id, appointment_id, nomor, status, estimasi_jam, dipanggil_at, selesai_at, created_at, updated_at")
    .eq("appointment_id", appointmentId)
    .maybeSingle();

  if (error) {
    throw ApiError.badRequest(`Gagal ambil antrian: ${error.message}`);
  }

  return data;
}

async function nextQueueNumberForDate(tanggal: string) {
  const { data: appointments, error: appointmentErr } = await supabaseAdmin
    .from("appointments")
    .select("id")
    .eq("tanggal", tanggal);

  if (appointmentErr) {
    throw ApiError.badRequest(`Gagal ambil appointment hari ini: ${appointmentErr.message}`);
  }

  const appointmentIds = (appointments ?? []).map((appointment) => appointment.id);
  if (appointmentIds.length === 0) return 1;

  const { data: queues, error: queueErr } = await supabaseAdmin
    .from("antrian")
    .select("nomor")
    .in("appointment_id", appointmentIds);

  if (queueErr) {
    throw ApiError.badRequest(`Gagal hitung nomor antrian: ${queueErr.message}`);
  }

  return Math.max(0, ...(queues ?? []).map((queue) => Number(queue.nomor) || 0)) + 1;
}

async function ensureQueueForAppointment(appointment: {
  id: string;
  tanggal: string;
  jam: string;
}) {
  const existing = await getAppointmentQueue(appointment.id);
  if (existing) return existing;

  const nomor = await nextQueueNumberForDate(appointment.tanggal);
  const { data, error } = await supabaseAdmin
    .from("antrian")
    .insert({
      appointment_id: appointment.id,
      nomor,
      status: "menunggu",
      estimasi_jam: appointment.jam,
    })
    .select("id, appointment_id, nomor, status, estimasi_jam, dipanggil_at, selesai_at, created_at, updated_at")
    .single();

  if (error || !data) {
    const alreadyExists =
      error?.code === "23505" || /duplicate key|antrian_appointment_id/i.test(error?.message ?? "");
    if (alreadyExists) {
      const queue = await getAppointmentQueue(appointment.id);
      if (queue) return queue;
    }
    throw ApiError.internal(`Gagal membuat antrian: ${error?.message ?? "unknown"}`);
  }

  return data;
}

/* ──────────────────────────────────────────────────────────────────── */
/*  POST /api/appointments/:id/check-in                                  */
/*  Public endpoint untuk QR scan resepsionis.                           */
/*  Transisi: terjadwal → menunggu + buat nomor antrian.                 */
/* ──────────────────────────────────────────────────────────────────── */
router.post(
  "/:id/check-in",
  asyncHandler(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);

    const { data: appt, error: aErr } = await supabaseAdmin
      .from("appointments")
      .select("id, pasien_id, dokter_id, status, tanggal, jam, jenis")
      .eq("id", id)
      .maybeSingle();

    if (aErr) throw ApiError.badRequest(`Gagal ambil appointment: ${aErr.message}`);
    if (!appt) throw ApiError.notFound("Appointment tidak ditemukan");

    if (appt.status === "dibatalkan" || appt.status === "tidak_hadir") {
      throw ApiError.unprocessable("Appointment sudah tidak aktif dan tidak bisa dikonfirmasi.");
    }
    if (appt.status === "selesai") {
      throw ApiError.unprocessable("Appointment sudah selesai.");
    }

    const queue = await ensureQueueForAppointment(appt);
    const shouldConfirm = appt.status === "terjadwal";

    if (shouldConfirm) {
      const { error: updateErr } = await supabaseAdmin
        .from("appointments")
        .update({ status: "menunggu" })
        .eq("id", id);

      if (updateErr) {
        throw ApiError.internal(`Gagal konfirmasi kedatangan: ${updateErr.message}`);
      }

      await Promise.all([
        createNotification({
          userId: appt.pasien_id,
          type: "konfirmasi",
          title: "Kedatangan Terkonfirmasi",
          description: `QR tiket Anda sudah discan resepsionis. Nomor antrian: ${queue.nomor}.`,
          link: "/pasien/jadwal",
        }),
        createNotification({
          userId: appt.dokter_id,
          type: "konfirmasi",
          title: "Pasien Sudah Check-in",
          description: `Pasien untuk ${appt.jenis} pukul ${String(appt.jam).slice(0, 5)} sudah dikonfirmasi resepsionis.`,
          link: "/dokter/appointment",
        }),
      ]);
    }

    const { data: updated, error: detailErr } = await supabaseAdmin
      .from("appointments")
      .select(APPOINTMENT_SELECT)
      .eq("id", id)
      .single();

    if (detailErr || !updated) {
      throw ApiError.internal(`Gagal ambil appointment terbaru: ${detailErr?.message ?? "unknown"}`);
    }

    res.json({
      appointment: updated,
      queue,
      confirmed: shouldConfirm,
    });
  }),
);

router.use(requireAuth);

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

    const userId = getUserId(req);
    const client = getUserClient(req);
    let query = client
      .from("appointments")
      .select(APPOINTMENT_SELECT)
      .order("tanggal", { ascending: true })
      .order("jam", { ascending: true });

    // RLS tetap aktif, tetapi filter eksplisit membuat kontrak endpoint jelas:
    // pasien melihat janji miliknya, dokter melihat janji yang ditujukan ke
    // akun dokter tersebut.
    query =
      role === "dokter"
        ? query.eq("dokter_id", userId)
        : query.eq("pasien_id", userId);

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

    // ── Validasi konflik ──────────────────────────────────────────────
    // Dua lapisan:
    //   1. Pasien yang sama tidak boleh double-book di jam yang sama
    //      (mencegah accidental duplicate dari satu user).
    //   2. Dokter yang dipilih tidak boleh sudah punya pasien lain di
    //      slot tersebut (mencegah jadwal bentrok dari dua pasien).
    //
    // Lapisan kedua di-back-up oleh partial unique index `uniq_dokter_slot_active`
    // (lihat migration 0004) — kalau request konkuren lolos cek ini, DB
    // akan reject dengan error 23505 yang ditangkap di catch insert.
    const ACTIVE_STATUSES = ["terjadwal", "menunggu", "sedang_ditangani"];

    const { data: pasienConflict } = await supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("pasien_id", userId)
      .eq("tanggal", body.tanggal)
      .eq("jam", body.jam)
      .in("status", ACTIVE_STATUSES)
      .maybeSingle();
    if (pasienConflict) {
      throw ApiError.conflict(
        "Anda sudah punya appointment di jam yang sama. Batalkan dulu sebelum buat baru.",
      );
    }

    const { data: dokterConflict } = await supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("dokter_id", body.dokterId)
      .eq("tanggal", body.tanggal)
      .eq("jam", body.jam)
      .in("status", ACTIVE_STATUSES)
      .maybeSingle();
    if (dokterConflict) {
      throw ApiError.conflict(
        "Slot ini sudah terisi pasien lain. Pilih jam yang berbeda.",
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
      // Postgres unique_violation (23505) → race-loss di unique index
      // `uniq_dokter_slot_active`. Beri pesan yang konsisten dengan
      // pre-check di atas supaya FE bisa menampilkan error yang sama.
      const isUniqueViolation =
        cErr?.code === "23505" ||
        /uniq_dokter_slot_active|duplicate key/i.test(cErr?.message ?? "");
      if (isUniqueViolation) {
        throw ApiError.conflict(
          "Slot ini baru saja dipesan pasien lain. Silakan pilih jam yang berbeda.",
        );
      }
      throw ApiError.badRequest(`Gagal buat appointment: ${cErr?.message ?? "unknown"}`);
    }

    await createNotification({
      userId: body.dokterId,
      type: body.jenis === "darurat" ? "darurat" : "konfirmasi",
      title: body.jenis === "darurat" ? "Appointment Darurat Baru" : "Appointment Baru",
      description: `${getAppointmentPatientName(created)} membuat ${created.jenis} pada ${created.tanggal} pukul ${created.jam.slice(0, 5)}.`,
      link: "/dokter/appointment",
    });

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

    await createNotification({
      userId: isOwner ? appt.dokter_id : appt.pasien_id,
      type: "pengumuman",
      title: "Appointment Dibatalkan",
      description: `Appointment tanggal ${appt.tanggal} pukul ${String(appt.jam).slice(0, 5)} dibatalkan oleh ${isOwner ? "pasien" : "dokter"}.`,
      link: isOwner ? "/dokter/appointment" : "/pasien/jadwal",
    });

    res.json({ appointment: updated });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  POST /api/appointments/:id/complete                                  */
/*  Dokter menyimpan rekam medis dan menyelesaikan appointment.           */
/* ──────────────────────────────────────────────────────────────────── */
const optionalExamText = (max: number) =>
  z.preprocess(
    (value) => (value === "" ? null : value),
    z.string().trim().max(max).optional().nullable(),
  );

const requiredExamText = (message: string, max: number) =>
  z
    .string({
      required_error: message,
      invalid_type_error: message,
    })
    .trim()
    .min(1, message)
    .max(max);

const optionalExamCost = z.preprocess(
  (value) => {
    if (value === "" || value === null || value === undefined) return null;
    return value;
  },
  z.coerce
    .number({ invalid_type_error: "Biaya harus berupa angka" })
    .min(0, "Biaya tidak boleh negatif")
    .optional()
    .nullable(),
);

const completeSchema = z.object({
  keluhan: optionalExamText(1000),
  areaGigi: optionalExamText(120),
  diagnosa: requiredExamText("Diagnosis wajib diisi", 1000),
  temuan: optionalExamText(2000),
  tindakan: requiredExamText("Tindakan wajib diisi", 2000),
  resep: optionalExamText(2000),
  catatan: optionalExamText(2000),
  biaya: optionalExamCost,
  perluKontrol: z.boolean().optional(),
});

function examValidationMessage(error: z.ZodError): string {
  const { fieldErrors, formErrors } = error.flatten();
  const fieldMessages = Object.values(fieldErrors)
    .flatMap((messages) => messages ?? [])
    .filter(Boolean);
  const messages = [...formErrors, ...fieldMessages];

  return messages[0] ?? "Lengkapi data pemeriksaan terlebih dahulu.";
}

function optionalText(value?: string | null): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function buildMedicalNotes(body: z.infer<typeof completeSchema>): string | null {
  const notes = [
    optionalText(body.keluhan) ? `Keluhan: ${optionalText(body.keluhan)}` : null,
    optionalText(body.areaGigi) ? `Area gigi: ${optionalText(body.areaGigi)}` : null,
    optionalText(body.temuan) ? `Temuan klinis: ${optionalText(body.temuan)}` : null,
    optionalText(body.catatan) ? `Catatan: ${optionalText(body.catatan)}` : null,
    body.perluKontrol ? "Perlu jadwal kontrol ulang." : null,
  ].filter(Boolean);

  return notes.length > 0 ? notes.join("\n") : null;
}

router.post(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    if (!isDokter(req)) {
      throw ApiError.forbidden("Hanya dokter yang dapat menyelesaikan appointment");
    }

    const { id } = idParamsSchema.parse(req.params);
    const parsedBody = completeSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      throw ApiError.badRequest(
        examValidationMessage(parsedBody.error),
        parsedBody.error.flatten(),
      );
    }
    const body = parsedBody.data;
    const userId = getUserId(req);

    const { data: appt, error: aErr } = await supabaseAdmin
      .from("appointments")
      .select("id, pasien_id, dokter_id, status, tanggal, jam, jenis, catatan_dokter")
      .eq("id", id)
      .maybeSingle();

    if (aErr) throw ApiError.badRequest(`Gagal ambil appointment: ${aErr.message}`);
    if (!appt) throw ApiError.notFound("Appointment tidak ditemukan");
    if (appt.dokter_id !== userId) {
      throw ApiError.forbidden("Anda tidak berwenang menyelesaikan appointment ini");
    }

    if (appt.status === "terjadwal") {
      throw ApiError.unprocessable(
        "Appointment belum terkonfirmasi. Scan QR kedatangan pasien terlebih dahulu.",
      );
    }
    if (appt.status === "selesai") {
      throw ApiError.unprocessable("Appointment sudah selesai.");
    }
    if (appt.status === "dibatalkan" || appt.status === "tidak_hadir") {
      throw ApiError.unprocessable("Appointment sudah tidak aktif dan tidak bisa diselesaikan.");
    }

    const catatan = buildMedicalNotes(body);
    const tindakan = optionalText(body.tindakan);
    const resep = optionalText(body.resep);

    const { data: record, error: recordErr } = await supabaseAdmin
      .from("rekam_medis")
      .insert({
        pasien_id: appt.pasien_id,
        dokter_id: appt.dokter_id,
        appointment_id: appt.id,
        tanggal: appt.tanggal,
        diagnosa: body.diagnosa,
        tindakan,
        resep,
        biaya: body.biaya ?? 0,
        catatan,
      })
      .select(REKAM_MEDIS_SELECT)
      .single();

    if (recordErr || !record) {
      throw ApiError.internal(
        `Gagal menyimpan rekam medis: ${recordErr?.message ?? "unknown"}`,
      );
    }

    const auditNote = [
      `[Pemeriksaan selesai] ${new Date().toISOString()}`,
      `Diagnosis: ${body.diagnosa}`,
      tindakan ? `Tindakan: ${tindakan}` : null,
      catatan,
    ]
      .filter(Boolean)
      .join("\n");

    const newCatatan = appt.catatan_dokter
      ? `${appt.catatan_dokter}\n\n${auditNote}`
      : auditNote;

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("appointments")
      .update({
        status: "selesai",
        catatan_dokter: newCatatan,
      })
      .eq("id", id)
      .select(APPOINTMENT_SELECT)
      .single();

    if (updateErr || !updated) {
      throw ApiError.internal(
        `Gagal menyelesaikan appointment: ${updateErr?.message ?? "unknown"}`,
      );
    }

    const { error: queueErr } = await supabaseAdmin
      .from("antrian")
      .update({
        status: "selesai",
        selesai_at: new Date().toISOString(),
      })
      .eq("appointment_id", id);

    if (queueErr) {
      console.error("[appointments] gagal update antrian selesai:", queueErr.message);
    }

    await createNotification({
      userId: appt.pasien_id,
      type: "konfirmasi",
      title: "Pemeriksaan Selesai",
      description: `Pemeriksaan ${appt.jenis} pada ${appt.tanggal} pukul ${String(appt.jam).slice(0, 5)} sudah selesai.`,
      link: "/pasien/riwayat",
    });

    res.json({ appointment: updated, record });
  }),
);

export default router;
