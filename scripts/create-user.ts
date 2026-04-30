/**
 * scripts/create-user.ts
 * ──────────────────────
 * Seed user via Supabase Admin API (`service_role`).
 * Reusable: bisa create user dengan role `pasien` atau `dokter`.
 *
 * Cara pakai:
 *   npm run user:create -- --email=admin@klinik.local --password=Admin12345! \
 *                          --role=dokter --name="Admin Klinik" \
 *                          [--spesialisasi="Dokter Gigi Umum"]
 *
 * Yang terjadi:
 *   1. supabase.auth.admin.createUser() → row di auth.users dengan
 *      email_confirm: true (langsung bisa login).
 *   2. Trigger DB `handle_new_user` auto-bikin row di `profiles`
 *      (membaca user_metadata.full_name & user_metadata.role).
 *   3. Skrip insert detail role → `dokter_profiles` atau `pasien_profiles`
 *      (kolom WAJIB sesuai schema 0001).
 *
 * Idempoten: kalau email sudah ada, skrip exit dengan pesan jelas.
 */

import { createClient } from "@supabase/supabase-js";
import { env } from "../src/config/env";

// ────────────────────────────────────────────────────────────
// Argumen CLI
// ────────────────────────────────────────────────────────────

interface ParsedArgs {
  email: string;
  password: string;
  role: "pasien" | "dokter";
  name: string;
  spesialisasi?: string;
}

function parseArgs(): ParsedArgs {
  const out: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m && m[1]) out[m[1]] = m[2] ?? "";
  }

  const email = out.email?.trim();
  const password = out.password;
  const roleRaw = (out.role ?? "dokter").trim().toLowerCase();
  const name = (out.name ?? "Admin Klinik").trim();
  const spesialisasi = out.spesialisasi?.trim() || "Dokter Gigi Umum";

  if (!email) throw new Error("Argumen --email wajib (cth. --email=admin@klinik.local).");
  if (!password) throw new Error("Argumen --password wajib (min 6 karakter).");
  if (password.length < 6) throw new Error("Password minimal 6 karakter (Supabase default).");
  if (roleRaw !== "pasien" && roleRaw !== "dokter") {
    throw new Error(`--role harus 'pasien' atau 'dokter'. Diberikan: '${roleRaw}'.`);
  }
  if (!name) throw new Error("Argumen --name tidak boleh kosong.");

  return {
    email,
    password,
    role: roleRaw,
    name,
    spesialisasi: roleRaw === "dokter" ? spesialisasi : undefined,
  };
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`→ Project : ${env.SUPABASE_URL}`);
  console.log(`→ Membuat user '${args.email}' (role=${args.role}) ...`);

  // 1. Buat row di auth.users + (via trigger) row di profiles.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: args.email,
    password: args.password,
    email_confirm: true,
    user_metadata: {
      full_name: args.name,
      role: args.role,
    },
  });

  if (createErr) {
    if (
      createErr.message.toLowerCase().includes("already") ||
      createErr.message.toLowerCase().includes("registered") ||
      createErr.message.toLowerCase().includes("exists")
    ) {
      console.error(`❌  Email '${args.email}' sudah terdaftar. Pakai email lain.`);
      process.exit(1);
    }
    throw createErr;
  }

  const userId = created.user?.id;
  if (!userId) throw new Error("auth.admin.createUser tidak mengembalikan user.id.");
  console.log(`✓ auth.users created: ${userId}`);

  // Beri waktu trigger handle_new_user selesai (umumnya instan, tapi
  // jaga-jaga di env yang lambat / cold start).
  await new Promise((resolve) => setTimeout(resolve, 400));

  // 2. Verifikasi profiles row terbentuk (oleh trigger).
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("id, full_name, role, email")
    .eq("id", userId)
    .single();

  if (profErr || !profile) {
    console.error("❌  profiles row gagal terbentuk:", profErr?.message);
    process.exit(1);
  }

  console.log(`✓ profiles ok        : ${profile.full_name} | role=${profile.role}`);

  // 3. Insert detail tabel sesuai role.
  if (args.role === "dokter") {
    const { error: dokErr } = await admin.from("dokter_profiles").upsert(
      {
        id: userId,
        spesialisasi: args.spesialisasi!,
        rating: 0,
        pengalaman_tahun: 0,
      },
      { onConflict: "id" },
    );
    if (dokErr) {
      console.error(`⚠  Gagal upsert dokter_profiles: ${dokErr.message}`);
    } else {
      console.log(`✓ dokter_profiles ok : spesialisasi='${args.spesialisasi}'`);
    }
  } else {
    const { error: pasErr } = await admin.from("pasien_profiles").upsert(
      { id: userId },
      { onConflict: "id" },
    );
    if (pasErr) {
      console.error(`⚠  Gagal upsert pasien_profiles: ${pasErr.message}`);
    } else {
      console.log(`✓ pasien_profiles ok`);
    }
  }

  console.log("\n✅  Akun siap pakai. Kredensial:");
  console.log(`     email    : ${args.email}`);
  console.log(`     password : ${args.password}`);
  console.log(`     role     : ${args.role}`);
  console.log(`     user_id  : ${userId}`);
  console.log("\nLogin di frontend Next.js (http://localhost:3000) lalu masuk ke dashboard.\n");
}

main().catch((err) => {
  console.error("\n❌  Gagal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
