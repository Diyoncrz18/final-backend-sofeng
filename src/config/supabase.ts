import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "./env";

/**
 * supabaseAdmin
 * ─────────────
 * Server-only client menggunakan SERVICE_ROLE key. Bypass RLS.
 * Pakai HANYA untuk operasi admin yang sudah diotentikasi/diotorisasi
 * di sisi backend (misal: createUser, listUsers, write tabel sistem).
 *
 * ⚠️ JANGAN pernah kirim client ini ke browser / leak ke response.
 */
export const supabaseAdmin: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

/**
 * createSupabaseUserClient
 * ────────────────────────
 * Client per-request yang bertindak sebagai user (RLS aktif).
 * Pakai untuk operasi data user: select profil sendiri, insert appointment, dll.
 *
 * @param accessToken JWT dari header Authorization (sudah diverifikasi).
 */
export function createSupabaseUserClient(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
