import type { Request, Response } from "express";

/**
 * 404 handler — dipasang setelah semua routes valid, sebelum errorHandler.
 */
export function notFound(req: Request, res: Response) {
  res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
}
