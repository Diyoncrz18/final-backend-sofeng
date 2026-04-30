import { Router } from "express";
import { z } from "zod";

import { isDevelopment } from "../config/env";
import { createSupabaseUserClient, supabaseAdmin } from "../config/supabase";
import { authLimiter, registerLimiter } from "../middlewares/rateLimit";
import { requireAuth } from "../middlewares/requireAuth";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  setRefreshCookie,
} from "../utils/cookies";

const router = Router();

/* ──────────────────────────────────────────────────────────────────── */
/*  Helper: bentuk response auth standar.                                */
/*  Refresh token TIDAK pernah masuk JSON — hanya di httpOnly cookie.    */
/* ──────────────────────────────────────────────────────────────────── */
type SupabaseSession = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
};

function authResponseBody(user: unknown, session: SupabaseSession) {
  return {
    user,
    session: {
      access_token: session.access_token,
      expires_at: session.expires_at,
    },
  };
}

/* ──────────────────────────────────────────────────────────────────── */
/*  POST /api/auth/login                                                 */
/*  Login email + password via Supabase Auth.                            */
/*                                                                       */
/*  Response :                                                           */
/*    body   = { user, session: { access_token, expires_at } }           */
/*    cookie = klinik_rt (httpOnly, refresh_token)                       */
/* ──────────────────────────────────────────────────────────────────── */
const loginSchema = z.object({
  email: z.string().email("Email tidak valid"),
  password: z.string().min(6, "Password minimal 6 karakter"),
});

router.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);

    const { data, error } = await supabaseAdmin.auth.signInWithPassword(body);
    if (error || !data.session) {
      // Pesan generik — jangan beri sinyal email exists / password salah
      // (mencegah user enumeration).
      throw ApiError.unauthorized("Email atau password salah");
    }

    setRefreshCookie(res, data.session.refresh_token);
    res.json(authResponseBody(data.user, data.session));
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  POST /api/auth/register                                              */
/*  Buat user baru. Role disimpan di user_metadata.                      */
/*                                                                       */
/*  Catatan email_confirm:                                               */
/*  - dev → true  : user langsung bisa login tanpa klik link verifikasi  */
/*  - prod → false: kirim email konfirmasi via Supabase Auth (default)   */
/* ──────────────────────────────────────────────────────────────────── */
const registerSchema = loginSchema.extend({
  fullName: z.string().min(2, "Nama minimal 2 karakter"),
  role: z.enum(["pasien", "dokter"]).default("pasien"),
});

router.post(
  "/register",
  registerLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: body.email,
      password: body.password,
      // Auto-confirm di development supaya UX langsung bisa login
      // tanpa email verification flow.
      email_confirm: isDevelopment,
      user_metadata: {
        full_name: body.fullName,
        role: body.role,
      },
    });

    if (error || !data.user) {
      const message = error?.message ?? "Gagal membuat akun";
      // Supabase return "User already registered" → 409 lebih akurat.
      if (/already registered|already exists/i.test(message)) {
        throw ApiError.conflict("Email sudah terdaftar");
      }
      throw ApiError.badRequest(message);
    }

    res.status(201).json({ user: data.user });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  POST /api/auth/refresh                                               */
/*  Tukar refresh_token (httpOnly cookie) → access_token baru.           */
/*  Dipanggil otomatis oleh frontend saat access_token expired.          */
/* ──────────────────────────────────────────────────────────────────── */
router.post(
  "/refresh",
  authLimiter,
  asyncHandler(async (req, res) => {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken || typeof refreshToken !== "string") {
      throw ApiError.unauthorized("Sesi tidak ditemukan");
    }

    const { data, error } = await supabaseAdmin.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session) {
      // Refresh token invalid/expired → bersihkan cookie supaya FE
      // langsung redirect ke login.
      clearRefreshCookie(res);
      throw ApiError.unauthorized("Sesi expired, silakan login kembali");
    }

    // Rotate refresh token (best-practice: setiap refresh dapat token baru).
    setRefreshCookie(res, data.session.refresh_token);
    res.json(authResponseBody(data.user, data.session));
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/auth/me                                                     */
/*  Ambil user dari JWT (cek session valid).                             */
/* ──────────────────────────────────────────────────────────────────────*/
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  POST /api/auth/logout                                                */
/*  Idempotent: selalu clear cookie + sukses, walau revoke gagal.        */
/* ──────────────────────────────────────────────────────────────────── */
router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.accessToken) {
      try {
        await createSupabaseUserClient(req.accessToken).auth.signOut();
      } catch (err) {
        // Logout secara konseptual sukses dari sisi client (cookie dihapus).
        // Hanya log warning kalau revoke gagal — JANGAN throw.
        console.warn(
          "[auth.logout] gagal revoke session di Supabase:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    clearRefreshCookie(res);
    res.json({ message: "Logged out" });
  }),
);

export default router;
