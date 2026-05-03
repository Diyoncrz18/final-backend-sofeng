/**
 * scripts/create-user.ts
 * ──────────────────────
 * Seed user via Supabase Admin API (`service_role`).
 * Reusable: bisa create user dengan role `pasien` atau `dokter`.
 *
 * Cara pakai:
 *   npm run user:create -- --email=admin@klinik.local --password=Admin12345! \
 *                          --role=dokter --name="Admin Klinik" \
 *                          [--spesialisasi="Dokter Gigi Umum"] [--nip=...] \
 *                          [--sip=...] [--bio="..."] [--pengalaman=5]
 *
 * Yang terjadi:
 *   1. supabase.auth.admin.createUser() → row di auth.users dengan
 *      email_confirm: true (langsung bisa login).
 *   2. Trigger DB `handle_new_user` auto-bikin row di `profiles`
 *      (membaca user_metadata.full_name & user_metadata.role).
 *   3. Skrip insert detail role → `dokter_profiles` atau `pasien_profiles`
 *      (kolom WAJIB sesuai schema 0001).
 *
 * Idempoten: kalau email sudah ada, skrip update password + metadata role
 * lalu memastikan row `profiles` dan detail role tetap konsisten.
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
  nip?: string;
  sip?: string;
  bio?: string;
  pengalamanTahun?: number;
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
  const defaultName = roleRaw === "dokter" ? "Dokter Klinik" : "Pasien Klinik";
  const name = (out.name ?? defaultName).trim();
  const spesialisasi = out.spesialisasi?.trim() || "Dokter Gigi Umum";
  const nip = out.nip?.trim() || undefined;
  const sip = out.sip?.trim() || undefined;
  const bio = out.bio?.trim() || undefined;
  const pengalamanRaw = out.pengalaman ?? out.pengalamanTahun ?? out["pengalaman-tahun"];

  if (!email) throw new Error("Argumen --email wajib (cth. --email=admin@klinik.local).");
  if (!password) throw new Error("Argumen --password wajib (min 6 karakter).");
  if (password.length < 6) throw new Error("Password minimal 6 karakter (Supabase default).");
  if (roleRaw !== "pasien" && roleRaw !== "dokter") {
    throw new Error(`--role harus 'pasien' atau 'dokter'. Diberikan: '${roleRaw}'.`);
  }
  if (!name) throw new Error("Argumen --name tidak boleh kosong.");
  if (pengalamanRaw !== undefined && !/^\d+$/.test(pengalamanRaw.trim())) {
    throw new Error("Argumen --pengalaman harus berupa angka tahun non-negatif.");
  }

  return {
    email,
    password,
    role: roleRaw,
    name,
    spesialisasi: roleRaw === "dokter" ? spesialisasi : undefined,
    nip: roleRaw === "dokter" ? nip : undefined,
    sip: roleRaw === "dokter" ? sip : undefined,
    bio: roleRaw === "dokter" ? bio : undefined,
    pengalamanTahun:
      roleRaw === "dokter" && pengalamanRaw !== undefined
        ? Number(pengalamanRaw)
        : undefined,
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
  let userId: string | undefined;
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
      console.log(`ℹ  Email '${args.email}' sudah terdaftar. Memperbarui akun yang ada ...`);

      let existingUserId: string | undefined;
      for (let page = 1; page <= 20 && !existingUserId; page += 1) {
        const { data: usersPage, error: listErr } = await admin.auth.admin.listUsers({
          page,
          perPage: 1000,
        });
        if (listErr) throw listErr;

        const matchedUser = usersPage.users.find(
          (user) => user.email?.toLowerCase() === args.email.toLowerCase(),
        );
        existingUserId = matchedUser?.id;

        if (usersPage.users.length < 1000) break;
      }

      if (!existingUserId) {
        console.error(`❌  Email '${args.email}' terdeteksi sudah ada, tapi user tidak ditemukan.`);
        process.exit(1);
      }

      const { error: updateErr } = await admin.auth.admin.updateUserById(existingUserId, {
        password: args.password,
        email_confirm: true,
        user_metadata: {
          full_name: args.name,
          role: args.role,
        },
      });
      if (updateErr) throw updateErr;

      userId = existingUserId;
      console.log(`✓ auth.users updated: ${userId}`);
    } else {
      throw createErr;
    }
  }

  userId ??= created.user?.id;
  if (!userId) throw new Error("auth.admin.createUser tidak mengembalikan user.id.");
  if (created.user?.id) console.log(`✓ auth.users created: ${userId}`);

  // Beri waktu trigger handle_new_user selesai (umumnya instan, tapi
  // jaga-jaga di env yang lambat / cold start).
  await new Promise((resolve) => setTimeout(resolve, 400));

  // 2. Pastikan profiles row terbentuk dan sinkron dengan role terbaru.
  const { error: profileUpsertErr } = await admin.from("profiles").upsert(
    {
      id: userId,
      email: args.email,
      full_name: args.name,
      role: args.role,
    },
    { onConflict: "id" },
  );
  if (profileUpsertErr) {
    console.error("❌  profiles row gagal disinkronkan:", profileUpsertErr.message);
    process.exit(1);
  }

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
        nip: args.nip,
        sip: args.sip,
        spesialisasi: args.spesialisasi!,
        rating: 0,
        bio: args.bio,
        pengalaman_tahun: args.pengalamanTahun ?? 0,
      },
      { onConflict: "id" },
    );
    if (dokErr) {
      console.error(`⚠  Gagal upsert dokter_profiles: ${dokErr.message}`);
    } else {
      console.log(`✓ dokter_profiles ok : spesialisasi='${args.spesialisasi}'`);
      if (args.nip) console.log(`                         nip='${args.nip}'`);
      if (args.sip) console.log(`                         sip='${args.sip}'`);
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
