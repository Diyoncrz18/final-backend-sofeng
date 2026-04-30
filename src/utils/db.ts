import type { Request } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseUserClient } from "../config/supabase";
import { ApiError } from "./ApiError";

/**
 * db.ts — Helpers untuk akses Supabase di route handlers.
 *
 * Aturan:
 *  • Pakai `getUserClient(req)` untuk operasi data user (RLS aktif).
 *  • Pakai `supabaseAdmin` (import langsung) HANYA untuk operasi yang
 *    butuh bypass RLS (seed, system job, atau operasi yang policy-nya
 *    sengaja restrictive — mis. cancel appointment dengan validasi BE).
 */

export type Role = "pasien" | "dokter";

/**
 * Ambil Supabase client yang scoped ke user yang sedang login.
 * Wajib dipakai setelah `requireAuth` middleware.
 */
export function getUserClient(req: Request): SupabaseClient {
  if (!req.accessToken) {
    throw ApiError.unauthorized("Access token tidak ditemukan di request");
  }
  return createSupabaseUserClient(req.accessToken);
}

/**
 * Ambil role user dari JWT user_metadata. Tidak melakukan DB call —
 * berasumsi metadata diset benar saat /register.
 */
export function getRole(req: Request): Role | null {
  const r = req.user?.user_metadata?.role;
  return r === "pasien" || r === "dokter" ? r : null;
}

/**
 * Lempar 403 kalau user bukan role yang diharapkan.
 * @example requireRole(req, "pasien");
 */
export function requireRole(req: Request, role: Role): void {
  const actual = getRole(req);
  if (actual !== role) {
    throw ApiError.forbidden(
      `Endpoint ini khusus ${role}. Role Anda: ${actual ?? "tidak diketahui"}.`,
    );
  }
}

/**
 * Helper boolean — kadang lebih natural daripada try/catch requireRole.
 */
export function isPasien(req: Request): boolean {
  return getRole(req) === "pasien";
}

export function isDokter(req: Request): boolean {
  return getRole(req) === "dokter";
}

/**
 * Ambil ID user yang login. Throw kalau tidak ada (seharusnya tidak terjadi
 * setelah requireAuth).
 */
export function getUserId(req: Request): string {
  if (!req.user?.id) {
    throw ApiError.unauthorized("User ID tidak ditemukan");
  }
  return req.user.id;
}
