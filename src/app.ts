import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";

import { env } from "./config/env";
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
        // Izinkan tools non-browser (curl, Postman) — origin undefined.
        if (!origin) return callback(null, true);
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
