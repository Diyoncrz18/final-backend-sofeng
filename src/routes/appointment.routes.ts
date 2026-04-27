import { Router } from "express";

import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../utils/asyncHandler";

const router = Router();

router.use(requireAuth);

/**
 * GET /api/appointments
 * Daftar appointment milik user yang sedang login.
 * TODO: Query tabel `appointments` setelah skema siap.
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({
      message: "Stub: list appointment — implement setelah skema DB siap.",
      user: req.user,
      items: [],
    });
  }),
);

/**
 * POST /api/appointments
 * Buat appointment baru.
 */
router.post(
  "/",
  asyncHandler(async (_req, res) => {
    res.status(501).json({
      error: { message: "Not implemented yet" },
    });
  }),
);

export default router;
