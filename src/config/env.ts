import "dotenv/config";
import { z } from "zod";

/**
 * Environment schema
 * ──────────────────
 * Validasi seluruh env var saat boot. Jika invalid, proses langsung exit
 * dengan pesan jelas — daripada crash di runtime random.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  SUPABASE_URL: z.string().url("SUPABASE_URL harus berupa URL valid"),
  SUPABASE_ANON_KEY: z.string().min(20, "SUPABASE_ANON_KEY tidak valid"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, "SUPABASE_SERVICE_ROLE_KEY tidak valid"),

  // ── Cookie config (refresh token disimpan sebagai httpOnly cookie) ────
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("\n❌  Environment variables tidak valid:");
  console.error(parsed.error.flatten().fieldErrors);
  console.error("\n→ Cek `.env` dan bandingkan dengan `.env.example`.\n");
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
