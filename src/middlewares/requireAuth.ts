import type { NextFunction, Request, Response } from "express";

import { supabaseAdmin } from "../config/supabase";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";

/**
 * requireAuth
 * ───────────
 * Memvalidasi JWT Supabase dari header `Authorization: Bearer <token>`.
 * Jika valid, attach `req.user` dan `req.accessToken`.
 * Jika tidak, lempar 401 lewat `ApiError`.
 *
 * Frontend harus mengirim token yang didapat dari Supabase Auth (mis. signInWithPassword).
 */
export const requireAuth = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw ApiError.unauthorized("Missing bearer token");
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      throw ApiError.unauthorized("Empty bearer token");
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      throw ApiError.unauthorized(error?.message ?? "Invalid or expired token");
    }

    req.user = data.user;
    req.accessToken = token;
    next();
  },
);
