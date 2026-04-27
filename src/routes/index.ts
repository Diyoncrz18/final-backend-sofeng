import { Router } from "express";

import appointmentRoutes from "./appointment.routes";
import authRoutes from "./auth.routes";
import healthRoutes from "./health.routes";
import pasienRoutes from "./pasien.routes";

const router = Router();

router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/pasien", pasienRoutes);
router.use("/appointments", appointmentRoutes);

export default router;
