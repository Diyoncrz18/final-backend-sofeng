import { Router } from "express";

import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../utils/asyncHandler";

const router = Router();

// Semua endpoint di bawah ini butuh auth.
router.use(requireAuth);

/**
 * GET /api/pasien/me
 * Profil pasien yang sedang login.
 *
 * TODO: Setelah skema `pasien_profiles` dibuat di Supabase,
 *       gunakan `createSupabaseUserClient(req.accessToken!)` untuk select
 *       agar RLS aktif sebagai user.
 */
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    res.json({
      message: "Stub: profil pasien — implement setelah skema DB siap.",
      user: req.user,
    });
  }),
);

export default router;
