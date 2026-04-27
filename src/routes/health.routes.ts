import { Router } from "express";

const router = Router();

/**
 * GET /api/health
 * Liveness probe ringan — tidak menyentuh database.
 */
router.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "backend-klinik-sofeng",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

export default router;
