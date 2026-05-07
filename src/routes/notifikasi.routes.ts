import { Router, type Response } from "express";
import { z } from "zod";

import { supabaseAdmin } from "../config/supabase";
import { requireAuth } from "../middlewares/requireAuth";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";
import { getUserClient, getUserId } from "../utils/db";

const router = Router();
router.use(requireAuth);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  unread: z.enum(["0", "1"]).optional(),
});

const idParamsSchema = z.object({
  id: z.string().uuid("ID notifikasi tidak valid"),
});

const NOTIFIKASI_SELECT =
  "id, user_id, type, title, description, link, read_at, created_at";

async function loadNotificationFeed(userId: string, limit = 80) {
  const { data, error } = await supabaseAdmin
    .from("notifikasi")
    .select(NOTIFIKASI_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw ApiError.badRequest(`Gagal ambil notifikasi: ${error.message}`);
  }

  const { count, error: countError } = await supabaseAdmin
    .from("notifikasi")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);

  if (countError) {
    throw ApiError.badRequest(`Gagal hitung notifikasi: ${countError.message}`);
  }

  return {
    items: data ?? [],
    unreadCount: count ?? 0,
    serverTime: new Date().toISOString(),
  };
}

function writeSseEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const params = listQuerySchema.parse(req.query);
    const userId = getUserId(req);
    const client = getUserClient(req);

    let query = client
      .from("notifikasi")
      .select(NOTIFIKASI_SELECT)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(params.limit);

    if (params.unread === "1") {
      query = query.is("read_at", null);
    }

    const { data, error } = await query;
    if (error) throw ApiError.badRequest(`Gagal ambil notifikasi: ${error.message}`);

    const { count, error: countError } = await client
      .from("notifikasi")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null);

    if (countError) {
      throw ApiError.badRequest(`Gagal hitung notifikasi: ${countError.message}`);
    }

    res.json({
      items: data ?? [],
      unreadCount: count ?? 0,
      serverTime: new Date().toISOString(),
    });
  }),
);

router.get(
  "/stream",
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    let closed = false;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendSnapshot = async () => {
      try {
        if (closed || res.destroyed) return;
        const payload = await loadNotificationFeed(userId);
        if (!closed && !res.destroyed) {
          writeSseEvent(res, "snapshot", payload);
        }
      } catch (error) {
        if (!closed && !res.destroyed) {
          writeSseEvent(res, "error", {
            message: error instanceof Error ? error.message : "Gagal sinkron notifikasi",
          });
        }
      }
    };

    await sendSnapshot();

    const channel = supabaseAdmin
      .channel(`notifikasi:${userId}:${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifikasi",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void sendSnapshot();
        },
      )
      .subscribe((status) => {
        if (!closed && !res.destroyed) {
          writeSseEvent(res, "status", {
            status,
            serverTime: new Date().toISOString(),
          });
        }
      });

    const heartbeatId = setInterval(() => {
      if (!closed && !res.destroyed) {
        writeSseEvent(res, "heartbeat", { serverTime: new Date().toISOString() });
      }
    }, 25_000);

    req.on("close", () => {
      closed = true;
      clearInterval(heartbeatId);
      void supabaseAdmin.removeChannel(channel);
    });
  }),
);

router.patch(
  "/read-all",
  asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    const client = getUserClient(req);
    const readAt = new Date().toISOString();

    const { error } = await client
      .from("notifikasi")
      .update({ read_at: readAt })
      .eq("user_id", userId)
      .is("read_at", null);

    if (error) throw ApiError.badRequest(`Gagal tandai semua notifikasi: ${error.message}`);

    res.json({ readAt });
  }),
);

router.patch(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const client = getUserClient(req);
    const readAt = new Date().toISOString();

    const { data, error } = await client
      .from("notifikasi")
      .update({ read_at: readAt })
      .eq("id", id)
      .select(NOTIFIKASI_SELECT)
      .single();

    if (error) throw ApiError.badRequest(`Gagal tandai notifikasi: ${error.message}`);

    res.json({ notification: data });
  }),
);

export default router;
