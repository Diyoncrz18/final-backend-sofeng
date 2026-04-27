import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * asyncHandler
 * ────────────
 * Wrapper agar handler async yang melempar error otomatis lewat ke `next(err)`.
 * Tanpa ini, error async akan unhandled dan tidak ditangkap errorHandler.
 *
 * @example
 *   router.get("/me", asyncHandler(async (req, res) => {
 *     const user = await fetchUser(req.user!.id);
 *     res.json({ user });
 *   }));
 */
export const asyncHandler =
  (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
