import { Router } from "express";
import { z } from "zod";

import { supabaseAdmin } from "../config/supabase";
import { requireAuth } from "../middlewares/requireAuth";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";

const router = Router();

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Login email + password via Supabase Auth.
// Frontend simpan `session.access_token` dan kirim sebagai Bearer token.
// ──────────────────────────────────────────────────────────────────────
const loginSchema = z.object({
  email: z.string().email("Email tidak valid"),
  password: z.string().min(6, "Password minimal 6 karakter"),
});

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);

    const { data, error } = await supabaseAdmin.auth.signInWithPassword(body);
    if (error || !data.session) {
      throw ApiError.unauthorized(error?.message ?? "Login gagal");
    }

    res.json({
      user: data.user,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });
  }),
);

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// Buat user baru. Role disimpan di `user_metadata`.
// ──────────────────────────────────────────────────────────────────────
const registerSchema = loginSchema.extend({
  fullName: z.string().min(2, "Nama minimal 2 karakter"),
  role: z.enum(["pasien", "dokter"]).default("pasien"),
});

router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: false,
      user_metadata: {
        full_name: body.fullName,
        role: body.role,
      },
    });

    if (error || !data.user) {
      throw ApiError.badRequest(error?.message ?? "Gagal membuat akun");
    }

    res.status(201).json({ user: data.user });
  }),
);

// ──────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// Ambil user dari JWT (cek session valid).
// ──────────────────────────────────────────────────────────────────────
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  }),
);

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// Sign out di sisi Supabase (revoke refresh token).
// ──────────────────────────────────────────────────────────────────────
router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.accessToken) {
      // signOut butuh client per-user agar Supabase tahu session mana yang direvoke
      const { createSupabaseUserClient } = await import("../config/supabase");
      const userClient = createSupabaseUserClient(req.accessToken);
      await userClient.auth.signOut();
    }
    res.json({ message: "Logged out" });
  }),
);

export default router;
