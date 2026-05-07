import { Router } from "express";
import { z } from "zod";

import { supabaseAdmin } from "../config/supabase";
import { requireAuth } from "../middlewares/requireAuth";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";
import {
  getUserClient,
  getUserId,
  requireRole,
} from "../utils/db";

const router = Router();

// Semua endpoint di bawah ini butuh auth.
router.use(requireAuth);

/* ──────────────────────────────────────────────────────────────────── */
/*  Helper: ambil profile + pasien_profile (auto-create kalau belum ada) */
/* ──────────────────────────────────────────────────────────────────── */
type PasienBundle = {
  profile: {
    id: string;
    full_name: string;
    role: "pasien" | "dokter";
    email: string | null;
    phone: string | null;
    avatar_url: string | null;
  };
  pasien: {
    id: string;
    no_rm: string | null;
    tanggal_lahir: string | null;
    jenis_kelamin: "L" | "P" | null;
    alamat: string | null;
    golongan_darah: string | null;
    riwayat_alergi: string | null;
    catatan_medis: string | null;
  };
};

type PasienProfileRow = PasienBundle["profile"];
type PasienClinicalRow = PasienBundle["pasien"];

type RekamMedisListRow = {
  id: string;
  pasien_id: string;
  dokter_id: string;
  appointment_id: string | null;
  tanggal: string;
  diagnosa: string;
  tindakan: string | null;
  resep: string | null;
  biaya: number | null;
  catatan: string | null;
  created_at: string;
  updated_at: string;
  dokter: {
    id: string;
    spesialisasi: string;
    profile: {
      id: string;
      full_name: string;
      avatar_url: string | null;
    };
  } | null;
  appointment: {
    id: string;
    tanggal: string;
    jam: string;
    jenis: string;
    status: string;
    keluhan: string | null;
    catatan_dokter: string | null;
  } | null;
};

type AppointmentListRow = {
  id: string;
  pasien_id: string;
  dokter_id: string;
  tanggal: string;
  jam: string;
  jenis: string;
  status: string;
  keluhan: string | null;
  catatan_dokter: string | null;
  created_at: string;
  updated_at: string;
  pasien: {
    id: string;
    profile: {
      id: string;
      full_name: string;
      avatar_url: string | null;
    };
  } | null;
  dokter: {
    id: string;
    spesialisasi: string;
    profile: {
      id: string;
      full_name: string;
      avatar_url: string | null;
    };
  } | null;
};

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
  updated_at,
  dokter:dokter_profiles!rekam_medis_dokter_id_fkey (
    id,
    spesialisasi,
    profile:profiles!inner ( id, full_name, avatar_url )
  ),
  appointment:appointments!rekam_medis_appointment_id_fkey (
    id,
    tanggal,
    jam,
    jenis,
    status,
    keluhan,
    catatan_dokter
  )
`;

const APPOINTMENT_MEDICAL_SELECT = `
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

function groupByPatientId<T extends { pasien_id: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const current = grouped.get(row.pasien_id) ?? [];
    current.push(row);
    grouped.set(row.pasien_id, current);
  }
  return grouped;
}

async function ensurePasienBundle(userId: string): Promise<PasienBundle> {
  // 1. Profile (wajib ada — dibuat oleh trigger handle_new_user).
  const { data: profile, error: pErr } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, role, email, phone, avatar_url")
    .eq("id", userId)
    .single();

  if (pErr || !profile) {
    throw ApiError.notFound(
      "Profil tidak ditemukan. Hubungi admin (trigger handle_new_user mungkin gagal).",
    );
  }
  if (profile.role !== "pasien") {
    throw ApiError.forbidden("Akun ini bukan pasien.");
  }

  // 2. pasien_profiles — auto-create row kosong kalau belum ada.
  //    User-scoped client TIDAK bisa pakai service_role; tapi RLS sudah
  //    allow pasien insert row dengan id=auth.uid() lewat policy
  //    `pasien_insert_self`. Demi kemudahan, pakai admin client di sini.
  const { data: existing } = await supabaseAdmin
    .from("pasien_profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (existing) {
    return { profile, pasien: existing };
  }

  const { data: created, error: cErr } = await supabaseAdmin
    .from("pasien_profiles")
    .insert({ id: userId })
    .select("*")
    .single();

  if (cErr || !created) {
    throw ApiError.internal(
      `Gagal auto-create pasien_profiles: ${cErr?.message ?? "unknown"}`,
    );
  }

  return { profile, pasien: created };
}

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/pasien/me                                                   */
/*  Profile pasien (gabungan profiles + pasien_profiles).                */
/*  Auto-create row pasien_profiles saat first call.                     */
/* ──────────────────────────────────────────────────────────────────── */
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    requireRole(req, "pasien");
    const bundle = await ensurePasienBundle(getUserId(req));
    res.json(bundle);
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/pasien                                                     */
/*  Daftar semua pasien untuk dokter, lengkap dengan profil klinis,      */
/*  rekam medis, dan riwayat appointment.                               */
/* ──────────────────────────────────────────────────────────────────── */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    requireRole(req, "dokter");

    const { data: profileData, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, role, email, phone, avatar_url")
      .eq("role", "pasien")
      .order("full_name", { ascending: true });

    if (profileErr) {
      throw ApiError.badRequest(`Gagal ambil daftar pasien: ${profileErr.message}`);
    }

    const profiles = (profileData ?? []) as PasienProfileRow[];
    const patientIds = profiles.map((profile) => profile.id);

    let clinicalRows: PasienClinicalRow[] = [];
    let medicalRows: RekamMedisListRow[] = [];
    let appointmentRows: AppointmentListRow[] = [];

    if (patientIds.length > 0) {
      const { data: pasienData, error: pasienErr } = await supabaseAdmin
        .from("pasien_profiles")
        .select(
          "id, no_rm, tanggal_lahir, jenis_kelamin, alamat, golongan_darah, riwayat_alergi, catatan_medis",
        )
        .in("id", patientIds);

      if (pasienErr) {
        throw ApiError.badRequest(`Gagal ambil profil klinis pasien: ${pasienErr.message}`);
      }

      const { data: rekamData, error: rekamErr } = await supabaseAdmin
        .from("rekam_medis")
        .select(REKAM_MEDIS_SELECT)
        .in("pasien_id", patientIds)
        .order("tanggal", { ascending: false })
        .order("created_at", { ascending: false });

      if (rekamErr) {
        throw ApiError.badRequest(`Gagal ambil rekam medis: ${rekamErr.message}`);
      }

      const { data: appointmentData, error: appointmentErr } = await supabaseAdmin
        .from("appointments")
        .select(APPOINTMENT_MEDICAL_SELECT)
        .in("pasien_id", patientIds)
        .order("tanggal", { ascending: false })
        .order("jam", { ascending: false });

      if (appointmentErr) {
        throw ApiError.badRequest(
          `Gagal ambil riwayat appointment pasien: ${appointmentErr.message}`,
        );
      }

      clinicalRows = (pasienData ?? []) as PasienClinicalRow[];
      medicalRows = (rekamData ?? []) as unknown as RekamMedisListRow[];
      appointmentRows = (appointmentData ?? []) as unknown as AppointmentListRow[];
    }

    const clinicalById = new Map(clinicalRows.map((row) => [row.id, row]));
    const medicalByPatientId = groupByPatientId(medicalRows);
    const appointmentsByPatientId = groupByPatientId(appointmentRows);

    const items = profiles.map((profile) => ({
      profile,
      pasien: clinicalById.get(profile.id) ?? null,
      rekamMedis: medicalByPatientId.get(profile.id) ?? [],
      appointments: appointmentsByPatientId.get(profile.id) ?? [],
    }));

    res.json({ items });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  PATCH /api/pasien/me                                                 */
/*  Update profil pasien. Field yang boleh diubah dipisah:               */
/*    - profiles    : full_name, phone, avatar_url                       */
/*    - pasien_profiles: tanggal_lahir, jenis_kelamin, alamat,           */
/*                       golongan_darah, riwayat_alergi                  */
/*  Email TIDAK boleh diubah lewat sini (lewat Supabase Auth).           */
/* ──────────────────────────────────────────────────────────────────── */
const updateSchema = z
  .object({
    fullName: z.string().min(2).max(100).optional(),
    phone: z
      .string()
      .regex(/^[+\d][\d\s-]{6,19}$/, "Format nomor HP tidak valid")
      .optional()
      .nullable(),
    avatarUrl: z.string().url().optional().nullable(),

    tanggalLahir: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Format tanggal harus YYYY-MM-DD")
      .optional()
      .nullable(),
    jenisKelamin: z.enum(["L", "P"]).optional().nullable(),
    alamat: z.string().max(500).optional().nullable(),
    golonganDarah: z
      .enum(["A", "B", "AB", "O", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"])
      .optional()
      .nullable(),
    riwayatAlergi: z.string().max(500).optional().nullable(),
  })
  .strict();

router.patch(
  "/me",
  asyncHandler(async (req, res) => {
    requireRole(req, "pasien");
    const userId = getUserId(req);
    const body = updateSchema.parse(req.body);

    const client = getUserClient(req);

    // ── Update profiles (kalau ada field-nya) ──────────────────────────
    const profileUpdate: Record<string, unknown> = {};
    if (body.fullName !== undefined) profileUpdate.full_name = body.fullName;
    if (body.phone !== undefined) profileUpdate.phone = body.phone;
    if (body.avatarUrl !== undefined) profileUpdate.avatar_url = body.avatarUrl;

    if (Object.keys(profileUpdate).length > 0) {
      const { error } = await client
        .from("profiles")
        .update(profileUpdate)
        .eq("id", userId);
      if (error) throw ApiError.badRequest(`Update profil gagal: ${error.message}`);
    }

    // ── Update pasien_profiles ─────────────────────────────────────────
    const pasienUpdate: Record<string, unknown> = {};
    if (body.tanggalLahir !== undefined) pasienUpdate.tanggal_lahir = body.tanggalLahir;
    if (body.jenisKelamin !== undefined) pasienUpdate.jenis_kelamin = body.jenisKelamin;
    if (body.alamat !== undefined) pasienUpdate.alamat = body.alamat;
    if (body.golonganDarah !== undefined) pasienUpdate.golongan_darah = body.golonganDarah;
    if (body.riwayatAlergi !== undefined) pasienUpdate.riwayat_alergi = body.riwayatAlergi;

    if (Object.keys(pasienUpdate).length > 0) {
      // Pastikan row pasien_profiles sudah ada.
      await ensurePasienBundle(userId);

      const { error } = await client
        .from("pasien_profiles")
        .update(pasienUpdate)
        .eq("id", userId);
      if (error) throw ApiError.badRequest(`Update data pasien gagal: ${error.message}`);
    }

    const bundle = await ensurePasienBundle(userId);
    res.json(bundle);
  }),
);

export default router;
