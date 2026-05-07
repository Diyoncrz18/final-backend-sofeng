import { Router } from "express";

import appointmentRoutes from "./appointment.routes";
import authRoutes from "./auth.routes";
import chatRoutes from "./chat.routes";
import dokterRoutes from "./dokter.routes";
import healthRoutes from "./health.routes";
import notifikasiRoutes from "./notifikasi.routes";
import pasienRoutes from "./pasien.routes";

const router = Router();

router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/pasien", pasienRoutes);
router.use("/dokter", dokterRoutes);
router.use("/appointments", appointmentRoutes);
router.use("/notifikasi", notifikasiRoutes);
router.use("/chat", chatRoutes);

export default router;
