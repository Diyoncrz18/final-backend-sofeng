import { Router } from "express";
import { z } from "zod";

import { requireAuth } from "../middlewares/requireAuth";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";
import { getUserClient } from "../utils/db";

const router = Router();
router.use(requireAuth);

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/dokter                                                      */
/*  List semua dokter (untuk pemilihan saat booking).                    */
/*  Query params:                                                        */
/*    spesialisasi=Ortodonti  → filter (case-insensitive contains)       */
/*    q=rina                  → search nama (case-insensitive contains)  */
/* ──────────────────────────────────────────────────────────────────── */
const listQuerySchema = z.object({
  spesialisasi: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
});

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const params = listQuerySchema.parse(req.query);
    const client = getUserClient(req);

    // Join dokter_profiles → profiles via foreign key relasi.
    // Supabase syntax: `profiles!inner(...)` untuk join + filter.
    let query = client
      .from("dokter_profiles")
      .select(
        `
        id,
        nip,
        sip,
        spesialisasi,
        rating,
        bio,
        pengalaman_tahun,
        profile:profiles!inner (
          id,
          full_name,
          avatar_url,
          email
        )
      `,
      )
      .order("rating", { ascending: false });

    if (params.spesialisasi) {
      query = query.ilike("spesialisasi", `%${params.spesialisasi}%`);
    }
    if (params.q) {
      // Filter nested profiles.full_name pakai foreignTable syntax.
      query = query.ilike("profiles.full_name", `%${params.q}%`);
    }

    const { data, error } = await query;
    if (error) throw ApiError.badRequest(`Gagal ambil dokter: ${error.message}`);

    res.json({ items: data ?? [] });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/dokter/:id                                                  */
/*  Detail dokter beserta jadwal mingguan.                               */
/* ──────────────────────────────────────────────────────────────────── */
const idParamsSchema = z.object({
  id: z.string().uuid("ID dokter tidak valid"),
});

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const client = getUserClient(req);

    const { data: dokter, error: dErr } = await client
      .from("dokter_profiles")
      .select(
        `
        id,
        nip,
        sip,
        spesialisasi,
        rating,
        bio,
        pengalaman_tahun,
        profile:profiles!inner (
          id,
          full_name,
          avatar_url,
          email,
          phone
        )
      `,
      )
      .eq("id", id)
      .maybeSingle();

    if (dErr) throw ApiError.badRequest(`Gagal ambil dokter: ${dErr.message}`);
    if (!dokter) throw ApiError.notFound("Dokter tidak ditemukan");

    const { data: jadwal, error: jErr } = await client
      .from("jadwal_dokter")
      .select("id, hari, jam_mulai, jam_selesai, kuota, is_active")
      .eq("dokter_id", id)
      .eq("is_active", true)
      .order("hari", { ascending: true })
      .order("jam_mulai", { ascending: true });

    if (jErr) throw ApiError.badRequest(`Gagal ambil jadwal: ${jErr.message}`);

    res.json({ dokter, jadwal: jadwal ?? [] });
  }),
);

export default router;
