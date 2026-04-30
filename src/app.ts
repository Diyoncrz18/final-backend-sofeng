import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { env, isProduction } from "./config/env";
import { errorHandler } from "./middlewares/errorHandler";
import { notFound } from "./middlewares/notFound";
import apiRouter from "./routes";

/**
 * Bootstrap Express app.
 * Dipisah dari `server.ts` agar mudah di-import dari testing tools (supertest).
 */
export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // Security & logging
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Browser request normal → origin selalu ada.
        // Request tanpa origin (curl, Postman, server-to-server):
        //   - dev   : izinkan untuk DX
        //   - prod  : tolak untuk mengurangi attack surface CSRF +
        //             credentials (cookie httpOnly).
        if (!origin) {
          return isProduction
            ? callback(new Error("Origin diperlukan"))
            : callback(null, true);
        }
        if (env.ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin tidak diizinkan oleh CORS: ${origin}`));
      },
      credentials: true,
    }),
  );

  if (env.NODE_ENV !== "test") {
    app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  }

  // Body parsing
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Cookie parsing — diperlukan untuk endpoint /api/auth/refresh & logout
  // yang membaca refresh token dari httpOnly cookie.
  app.use(cookieParser());

  // Root info
  app.get("/", (_req, res) => {
    res.json({
      service: "backend-klinik-sofeng",
      env: env.NODE_ENV,
      docs: "/api/health",
    });
  });

  // API routes
  app.use("/api", apiRouter);

  // 404 + error handler — HARUS terakhir
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
