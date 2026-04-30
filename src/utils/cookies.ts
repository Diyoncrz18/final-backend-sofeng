import type { CookieOptions, Response } from "express";

import { env } from "../config/env";

/**
 * Cookie helpers — refresh token storage.
 * ────────────────────────────────────────
 * Refresh token disimpan di httpOnly cookie (tidak dapat dibaca oleh JS),
 * sehingga aman dari pencurian via XSS. Access token tetap dikirim ke
 * frontend sebagai JSON body (short-lived, in-memory only).
 *
 * Cookie hanya dikirim ke path /api/auth/* untuk meminimalkan exposure.
 */

export const REFRESH_COOKIE_NAME = "klinik_rt";

const COOKIE_PATH = "/api/auth";
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari

function baseCookieOptions(): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    path: COOKIE_PATH,
  };
  if (env.COOKIE_DOMAIN) {
    options.domain = env.COOKIE_DOMAIN;
  }
  return options;
}

export function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...baseCookieOptions(),
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  });
}

export function clearRefreshCookie(res: Response): void {
  // Pakai opsi yang sama persis (kecuali maxAge) supaya browser benar-benar
  // hapus cookie. Kalau path/domain berbeda, cookie lama akan tetap ada.
  res.clearCookie(REFRESH_COOKIE_NAME, baseCookieOptions());
}
