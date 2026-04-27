import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { env } from "../config/env";
import { ApiError } from "../utils/ApiError";

/**
 * Global error handler. Harus dipasang TERAKHIR di pipeline middleware
 * (setelah semua routes & notFound).
 *
 * Penanganan:
 * - `ApiError`     → status custom + payload `{ error: { message, details } }`
 * - `ZodError`     → 400 Validation Error + flatten field errors
 * - lainnya        → 500 Internal Server Error (stack hanya saat development)
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: {
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        message: "Validation error",
        details: err.flatten(),
      },
    });
    return;
  }

  // Unknown error
  console.error("[unhandled error]", err);
  res.status(500).json({
    error: {
      message: "Internal Server Error",
      ...(env.NODE_ENV === "development" && err instanceof Error
        ? { stack: err.stack }
        : {}),
    },
  });
};
