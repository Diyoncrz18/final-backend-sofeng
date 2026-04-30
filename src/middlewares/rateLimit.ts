import rateLimit from "express-rate-limit";

import { env } from "../config/env";

/**
 * Rate limiters
 * ─────────────
 * - `authLimiter`     : login + refresh — proteksi brute-force credential.
 * - `registerLimiter` : register — proteksi spam akun baru.
 *
 * Limit dimatikan saat NODE_ENV=test agar test suite tidak terblokir.
 *
 * Catatan: kalau backend di-deploy di belakang reverse proxy (Vercel,
 * Render, Nginx), `app.set('trust proxy', 1)` di app.ts wajib aktif
 * supaya `req.ip` membaca header X-Forwarded-For dengan benar.
 */

const skipInTests = () => env.NODE_ENV === "test";

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 10,                  // 10 percobaan per IP per window
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: {
    error: {
      message:
        "Terlalu banyak percobaan login. Silakan coba lagi dalam beberapa menit.",
    },
  },
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 jam
  max: 5,                   // 5 akun baru per IP per jam
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: skipInTests,
  message: {
    error: {
      message:
        "Terlalu banyak pendaftaran. Silakan coba lagi nanti.",
    },
  },
});
