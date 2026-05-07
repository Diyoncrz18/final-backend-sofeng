import { Router } from "express";
import { z } from "zod";

import { supabaseAdmin } from "../config/supabase";
import { requireAuth } from "../middlewares/requireAuth";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";
import { getUserClient, getUserId, requireRole } from "../utils/db";

const router = Router();
router.use(requireAuth);

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/dokter                                                      */
/*  List semua dokter (untuk pemilihan saat booking).                    */
/*  Query params:                                                        */
/*    spesialisasi=Ortodonti  → filter (case-insensitive contains)       */
/*    q=rina                  → search nama (case-insensitive contains)  */
/* ──────────────────────────────────────────────────────────────────── */
const listQuerySchema = z.object({
  spesialisasi: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
});

const jadwalSchema = z
  .object({
    hari: z.number().int().min(0).max(6),
    jamMulai: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d(:\d{2})?$/, "Format jam mulai harus HH:MM"),
    jamSelesai: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d(:\d{2})?$/, "Format jam selesai harus HH:MM"),
    kuota: z.number().int().min(1).max(100).default(10),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine(
    (value) => normalizeTime(value.jamSelesai) > normalizeTime(value.jamMulai),
    "Jam selesai harus lebih besar dari jam mulai",
  );

const analyticsQuerySchema = z.object({
  range: z.enum(["week", "month", "year"]).default("month"),
});

type AnalyticsRange = z.infer<typeof analyticsQuerySchema>["range"];

type AppointmentAnalyticsRow = {
  id: string;
  pasien_id: string;
  tanggal: string;
  jam: string;
  jenis: string;
  status: string;
  created_at: string;
};

type RekamMedisAnalyticsRow = {
  id: string;
  pasien_id: string;
  tanggal: string;
  diagnosa: string;
  tindakan: string | null;
  biaya: number | string | null;
};

type PatientAnalyticsRow = {
  id: string;
  tanggal_lahir: string | null;
  jenis_kelamin: "L" | "P" | null;
};

function normalizeTime(value: string) {
  return value.length === 5 ? `${value}:00` : value;
}

function timeToMinutes(value: string) {
  const normalized = normalizeTime(value);
  const [hour = "0", minute = "0"] = normalized.split(":");
  return Number(hour) * 60 + Number(minute);
}

function hasOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string,
) {
  return timeToMinutes(startA) < timeToMinutes(endB) && timeToMinutes(startB) < timeToMinutes(endA);
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function inclusiveDays(from: string, to: string) {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

function analyticsPeriod(range: AnalyticsRange) {
  const today = startOfUtcDay(new Date());
  let fromDate: Date;

  if (range === "week") {
    const day = today.getUTCDay();
    fromDate = addDays(today, day === 0 ? -6 : 1 - day);
  } else if (range === "year") {
    fromDate = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  } else {
    fromDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  }

  const durationDays = inclusiveDays(isoDate(fromDate), isoDate(today));
  const previousToDate = addDays(fromDate, -1);
  const previousFromDate = addDays(previousToDate, -(durationDays - 1));

  return {
    from: isoDate(fromDate),
    to: isoDate(today),
    previousFrom: isoDate(previousFromDate),
    previousTo: isoDate(previousToDate),
    days: durationDays,
  };
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

function deltaPct(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function metric(current: number, previous: number) {
  return {
    value: current,
    previous,
    deltaPct: deltaPct(current, previous),
  };
}

function revenueOf(rows: RekamMedisAnalyticsRow[]) {
  return rows.reduce((sum, row) => sum + Number(row.biaya ?? 0), 0);
}

function inPeriod(row: { tanggal: string }, from: string, to: string) {
  return row.tanggal >= from && row.tanggal <= to;
}

function uniqueCount(rows: Array<{ pasien_id: string }>) {
  return new Set(rows.map((row) => row.pasien_id)).size;
}

function completionRate(rows: AppointmentAnalyticsRow[]) {
  if (rows.length === 0) return 0;
  return Math.round((rows.filter((row) => row.status === "selesai").length / rows.length) * 100);
}

function attendanceRate(rows: AppointmentAnalyticsRow[]) {
  if (rows.length === 0) return 0;
  const attended = rows.filter(
    (row) => row.status !== "dibatalkan" && row.status !== "tidak_hadir",
  ).length;
  return Math.round((attended / rows.length) * 100);
}

function formatTrendLabel(dateIso: string, range: AnalyticsRange) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  if (range === "year") {
    return new Intl.DateTimeFormat("id-ID", { month: "short" }).format(date);
  }
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short" }).format(date);
}

function buildVisitTrend(
  rows: AppointmentAnalyticsRow[],
  range: AnalyticsRange,
  from: string,
  to: string,
) {
  const grouped = new Map<string, number>();
  for (const row of rows) {
    const key = range === "year" ? row.tanggal.slice(0, 7) : row.tanggal;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  if (range === "year") {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    const buckets: Array<{ key: string; label: string; value: number }> = [];
    for (
      let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      cursor <= end;
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
    ) {
      const key = cursor.toISOString().slice(0, 7);
      buckets.push({ key, label: formatTrendLabel(`${key}-01`, range), value: grouped.get(key) ?? 0 });
    }
    return buckets;
  }

  const buckets: Array<{ key: string; label: string; value: number }> = [];
  for (
    let cursor = new Date(`${from}T00:00:00.000Z`);
    cursor <= new Date(`${to}T00:00:00.000Z`);
    cursor = addDays(cursor, 1)
  ) {
    const key = isoDate(cursor);
    buckets.push({ key, label: formatTrendLabel(key, range), value: grouped.get(key) ?? 0 });
  }
  return buckets;
}

function buildHourlyDistribution(rows: AppointmentAnalyticsRow[]) {
  const grouped = new Map<number, number>();
  for (const row of rows) {
    const hour = Number(row.jam.slice(0, 2));
    if (Number.isFinite(hour)) grouped.set(hour, (grouped.get(hour) ?? 0) + 1);
  }

  const hours = new Set<number>(Array.from({ length: 13 }, (_, index) => index + 8));
  for (const hour of grouped.keys()) hours.add(hour);

  return [...hours]
    .sort((a, b) => a - b)
    .map((hour) => ({
      key: String(hour).padStart(2, "0"),
      label: `${String(hour).padStart(2, "0")}:00`,
      value: grouped.get(hour) ?? 0,
    }));
}

function buildBreakdown(rows: AppointmentAnalyticsRow[], field: "jenis" | "status") {
  const grouped = new Map<string, number>();
  for (const row of rows) {
    const key = row[field];
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  return [...grouped.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({
      key,
      label: key.replace(/_/g, " "),
      value,
      percentage: percent(value, rows.length),
    }));
}

function calculateAge(tanggalLahir: string | null) {
  if (!tanggalLahir) return null;
  const birth = new Date(`${tanggalLahir}T00:00:00.000Z`);
  if (Number.isNaN(birth.getTime())) return null;
  const today = startOfUtcDay(new Date());
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = today.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

function buildDemographics(rows: PatientAnalyticsRow[]) {
  const genderMap = new Map<string, number>([
    ["L", 0],
    ["P", 0],
    ["Tidak diisi", 0],
  ]);
  const ageMap = new Map<string, number>([
    ["Anak", 0],
    ["Remaja", 0],
    ["Dewasa", 0],
    ["Lansia", 0],
    ["Tidak diisi", 0],
  ]);

  for (const row of rows) {
    const genderKey = row.jenis_kelamin ?? "Tidak diisi";
    genderMap.set(genderKey, (genderMap.get(genderKey) ?? 0) + 1);

    const age = calculateAge(row.tanggal_lahir);
    const ageKey =
      age === null
        ? "Tidak diisi"
        : age <= 12
          ? "Anak"
          : age <= 17
            ? "Remaja"
            : age >= 60
              ? "Lansia"
              : "Dewasa";
    ageMap.set(ageKey, (ageMap.get(ageKey) ?? 0) + 1);
  }

  const toBuckets = (map: Map<string, number>) =>
    [...map.entries()]
      .filter(([, value]) => value > 0)
      .map(([key, value]) => ({
        key,
        label: key === "L" ? "Laki-laki" : key === "P" ? "Perempuan" : key,
        value,
        percentage: percent(value, rows.length),
      }));

  return {
    gender: toBuckets(genderMap),
    ageGroups: toBuckets(ageMap),
  };
}

function buildTopDiagnoses(rows: RekamMedisAnalyticsRow[]) {
  const grouped = new Map<
    string,
    { diagnosa: string; count: number; revenue: number; latestDate: string; treatmentCount: number }
  >();

  for (const row of rows) {
    const diagnosa = row.diagnosa.trim() || "Tanpa diagnosa";
    const current =
      grouped.get(diagnosa.toLowerCase()) ??
      { diagnosa, count: 0, revenue: 0, latestDate: row.tanggal, treatmentCount: 0 };
    current.count += 1;
    current.revenue += Number(row.biaya ?? 0);
    current.latestDate = current.latestDate > row.tanggal ? current.latestDate : row.tanggal;
    if (row.tindakan?.trim()) current.treatmentCount += 1;
    grouped.set(diagnosa.toLowerCase(), current);
  }

  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || b.revenue - a.revenue)
    .slice(0, 5)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

function buildInsights(input: {
  appointments: AppointmentAnalyticsRow[];
  records: RekamMedisAnalyticsRow[];
  hourlyDistribution: Array<{ label: string; value: number }>;
  topDiagnoses: Array<{ diagnosa: string; count: number }>;
}) {
  const insights: Array<{ title: string; description: string; tone: "info" | "success" | "warning" }> = [];
  const busiestHour = input.hourlyDistribution.reduce(
    (best, item) => (item.value > best.value ? item : best),
    { label: "-", value: 0 },
  );
  const completion = completionRate(input.appointments);

  if (busiestHour.value > 0) {
    insights.push({
      title: "Jam tersibuk",
      description: `Kunjungan paling padat terjadi sekitar ${busiestHour.label} dengan ${busiestHour.value} appointment.`,
      tone: "info",
    });
  }
  if (input.topDiagnoses[0]) {
    insights.push({
      title: "Diagnosa dominan",
      description: `${input.topDiagnoses[0].diagnosa} menjadi kasus terbanyak dari rekam medis periode ini.`,
      tone: "warning",
    });
  }
  insights.push({
    title: "Tingkat penyelesaian",
    description:
      input.appointments.length === 0
        ? "Belum ada appointment pada periode ini."
        : `${completion}% appointment sudah diselesaikan berdasarkan status data saat ini.`,
    tone: completion >= 80 ? "success" : "info",
  });

  if (input.records.length === 0) {
    insights.push({
      title: "Data rekam medis",
      description: "Belum ada rekam medis pada periode ini, sehingga analitik klinis masih terbatas.",
      tone: "warning",
    });
  }

  return insights;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const params = listQuerySchema.parse(req.query);
    const client = getUserClient(req);

    // Join dokter_profiles → profiles via foreign key relasi.
    // Supabase syntax: `profiles!inner(...)` untuk join + filter.
    let query = client
      .from("dokter_profiles")
      .select(
        `
        id,
        nip,
        sip,
        spesialisasi,
        rating,
        bio,
        pengalaman_tahun,
        profile:profiles!inner (
          id,
          full_name,
          avatar_url,
          email
        )
      `,
      )
      .order("rating", { ascending: false });

    if (params.spesialisasi) {
      query = query.ilike("spesialisasi", `%${params.spesialisasi}%`);
    }
    if (params.q) {
      // Filter nested profiles.full_name pakai foreignTable syntax.
      query = query.ilike("profiles.full_name", `%${params.q}%`);
    }

    const { data, error } = await query;
    if (error) throw ApiError.badRequest(`Gagal ambil dokter: ${error.message}`);

    res.json({ items: data ?? [] });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/dokter/me/jadwal                                           */
/*  Jadwal praktik mingguan dokter yang sedang login.                    */
/* ──────────────────────────────────────────────────────────────────── */
router.get(
  "/me/jadwal",
  asyncHandler(async (req, res) => {
    requireRole(req, "dokter");
    const userId = getUserId(req);
    const client = getUserClient(req);

    const { data, error } = await client
      .from("jadwal_dokter")
      .select("id, dokter_id, hari, jam_mulai, jam_selesai, kuota, is_active")
      .eq("dokter_id", userId)
      .order("hari", { ascending: true })
      .order("jam_mulai", { ascending: true });

    if (error) throw ApiError.badRequest(`Gagal ambil jadwal dokter: ${error.message}`);

    res.json({ items: data ?? [] });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  POST /api/dokter/me/jadwal                                          */
/*  Tambah slot praktik rutin dokter login.                              */
/* ──────────────────────────────────────────────────────────────────── */
router.post(
  "/me/jadwal",
  asyncHandler(async (req, res) => {
    requireRole(req, "dokter");
    const userId = getUserId(req);
    const body = jadwalSchema.parse(req.body);
    const client = getUserClient(req);
    const jamMulai = normalizeTime(body.jamMulai);
    const jamSelesai = normalizeTime(body.jamSelesai);

    const { data: existing, error: existingErr } = await client
      .from("jadwal_dokter")
      .select("id, jam_mulai, jam_selesai")
      .eq("dokter_id", userId)
      .eq("hari", body.hari)
      .eq("is_active", true);

    if (existingErr) {
      throw ApiError.badRequest(`Gagal validasi jadwal dokter: ${existingErr.message}`);
    }

    const overlapping = (existing ?? []).find((row) =>
      hasOverlap(jamMulai, jamSelesai, row.jam_mulai, row.jam_selesai),
    );

    if (overlapping) {
      throw ApiError.conflict("Jadwal praktik bertumpuk dengan slot aktif lain.");
    }

    const { data: created, error } = await client
      .from("jadwal_dokter")
      .insert({
        dokter_id: userId,
        hari: body.hari,
        jam_mulai: jamMulai,
        jam_selesai: jamSelesai,
        kuota: body.kuota,
        is_active: body.isActive,
      })
      .select("id, dokter_id, hari, jam_mulai, jam_selesai, kuota, is_active")
      .single();

    if (error || !created) {
      throw ApiError.badRequest(`Gagal membuat jadwal dokter: ${error?.message ?? "unknown"}`);
    }

    res.status(201).json({ jadwal: created });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/dokter/me/analytics                                        */
/*  Analitik real dokter login, dihitung dari appointments + rekam_medis.*/
/* ──────────────────────────────────────────────────────────────────── */
router.get(
  "/me/analytics",
  asyncHandler(async (req, res) => {
    requireRole(req, "dokter");
    const userId = getUserId(req);
    const { range } = analyticsQuerySchema.parse(req.query);
    const period = analyticsPeriod(range);

    const { data: appointmentData, error: appointmentErr } = await supabaseAdmin
      .from("appointments")
      .select("id, pasien_id, tanggal, jam, jenis, status, created_at")
      .eq("dokter_id", userId)
      .gte("tanggal", period.previousFrom)
      .lte("tanggal", period.to);

    if (appointmentErr) {
      throw ApiError.badRequest(`Gagal ambil data appointment: ${appointmentErr.message}`);
    }

    const { data: allPatientAppointmentData, error: allPatientAppointmentErr } =
      await supabaseAdmin
        .from("appointments")
        .select("pasien_id, tanggal")
        .eq("dokter_id", userId)
        .lte("tanggal", period.to)
        .order("tanggal", { ascending: true });

    if (allPatientAppointmentErr) {
      throw ApiError.badRequest(
        `Gagal ambil histori pasien dokter: ${allPatientAppointmentErr.message}`,
      );
    }

    const { data: recordData, error: recordErr } = await supabaseAdmin
      .from("rekam_medis")
      .select("id, pasien_id, tanggal, diagnosa, tindakan, biaya")
      .eq("dokter_id", userId)
      .gte("tanggal", period.previousFrom)
      .lte("tanggal", period.to);

    if (recordErr) {
      throw ApiError.badRequest(`Gagal ambil data rekam medis: ${recordErr.message}`);
    }

    const appointments = (appointmentData ?? []) as unknown as AppointmentAnalyticsRow[];
    const records = (recordData ?? []) as unknown as RekamMedisAnalyticsRow[];

    const currentAppointments = appointments.filter((row) =>
      inPeriod(row, period.from, period.to),
    );
    const previousAppointments = appointments.filter((row) =>
      inPeriod(row, period.previousFrom, period.previousTo),
    );
    const currentRecords = records.filter((row) => inPeriod(row, period.from, period.to));
    const previousRecords = records.filter((row) =>
      inPeriod(row, period.previousFrom, period.previousTo),
    );

    const currentPatientIds = [...new Set(currentAppointments.map((row) => row.pasien_id))];
    let patientRows: PatientAnalyticsRow[] = [];

    if (currentPatientIds.length > 0) {
      const { data: patientData, error: patientErr } = await supabaseAdmin
        .from("pasien_profiles")
        .select("id, tanggal_lahir, jenis_kelamin")
        .in("id", currentPatientIds);

      if (patientErr) {
        throw ApiError.badRequest(`Gagal ambil demografi pasien: ${patientErr.message}`);
      }

      patientRows = (patientData ?? []) as unknown as PatientAnalyticsRow[];
    }

    const firstVisitByPatient = new Map<string, string>();
    for (const row of (allPatientAppointmentData ?? []) as Array<{
      pasien_id: string;
      tanggal: string;
    }>) {
      if (!firstVisitByPatient.has(row.pasien_id)) {
        firstVisitByPatient.set(row.pasien_id, row.tanggal);
      }
    }

    const newPatientCount = currentPatientIds.filter((patientId) => {
      const firstVisit = firstVisitByPatient.get(patientId);
      return firstVisit ? firstVisit >= period.from && firstVisit <= period.to : false;
    }).length;

    const previousPatientIds = [
      ...new Set(previousAppointments.map((row) => row.pasien_id)),
    ];
    const previousNewPatientCount = previousPatientIds.filter((patientId) => {
      const firstVisit = firstVisitByPatient.get(patientId);
      return firstVisit
        ? firstVisit >= period.previousFrom && firstVisit <= period.previousTo
        : false;
    }).length;

    const hourlyDistribution = buildHourlyDistribution(currentAppointments);
    const topDiagnoses = buildTopDiagnoses(currentRecords);

    res.json({
      range,
      period: {
        from: period.from,
        to: period.to,
        previousFrom: period.previousFrom,
        previousTo: period.previousTo,
        days: period.days,
      },
      kpis: {
        appointments: metric(currentAppointments.length, previousAppointments.length),
        uniquePatients: metric(
          uniqueCount(currentAppointments),
          uniqueCount(previousAppointments),
        ),
        newPatients: metric(newPatientCount, previousNewPatientCount),
        averageDailyAppointments: metric(
          Number((currentAppointments.length / period.days).toFixed(1)),
          Number((previousAppointments.length / period.days).toFixed(1)),
        ),
        completionRate: metric(
          completionRate(currentAppointments),
          completionRate(previousAppointments),
        ),
        attendanceRate: metric(
          attendanceRate(currentAppointments),
          attendanceRate(previousAppointments),
        ),
        emergencyCases: metric(
          currentAppointments.filter((row) => row.jenis === "darurat").length,
          previousAppointments.filter((row) => row.jenis === "darurat").length,
        ),
        revenue: metric(revenueOf(currentRecords), revenueOf(previousRecords)),
        medicalRecords: metric(currentRecords.length, previousRecords.length),
      },
      charts: {
        visitTrend: buildVisitTrend(currentAppointments, range, period.from, period.to),
        hourlyDistribution,
        appointmentTypes: buildBreakdown(currentAppointments, "jenis"),
        statuses: buildBreakdown(currentAppointments, "status"),
        demographics: buildDemographics(patientRows),
      },
      topDiagnoses,
      insights: buildInsights({
        appointments: currentAppointments,
        records: currentRecords,
        hourlyDistribution,
        topDiagnoses,
      }),
      generatedAt: new Date().toISOString(),
    });
  }),
);

/* ──────────────────────────────────────────────────────────────────── */
/*  GET /api/dokter/:id                                                  */
/*  Detail dokter beserta jadwal mingguan.                               */
/* ──────────────────────────────────────────────────────────────────── */
const idParamsSchema = z.object({
  id: z.string().uuid("ID dokter tidak valid"),
});

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const client = getUserClient(req);

    const { data: dokter, error: dErr } = await client
      .from("dokter_profiles")
      .select(
        `
        id,
        nip,
        sip,
        spesialisasi,
        rating,
        bio,
        pengalaman_tahun,
        profile:profiles!inner (
          id,
          full_name,
          avatar_url,
          email,
          phone
        )
      `,
      )
      .eq("id", id)
      .maybeSingle();

    if (dErr) throw ApiError.badRequest(`Gagal ambil dokter: ${dErr.message}`);
    if (!dokter) throw ApiError.notFound("Dokter tidak ditemukan");

    const { data: jadwal, error: jErr } = await client
      .from("jadwal_dokter")
      .select("id, hari, jam_mulai, jam_selesai, kuota, is_active")
      .eq("dokter_id", id)
      .eq("is_active", true)
      .order("hari", { ascending: true })
      .order("jam_mulai", { ascending: true });

    if (jErr) throw ApiError.badRequest(`Gagal ambil jadwal: ${jErr.message}`);

    res.json({ dokter, jadwal: jadwal ?? [] });
  }),
);

export default router;
