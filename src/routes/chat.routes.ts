import { Router } from "express";
import { z } from "zod";

import { requireAuth } from "../middlewares/requireAuth";
import {
  createChatConversation,
  listChatConversations,
  markChatConversationRead,
  sendChatMessage,
} from "../services/chat.service";
import { asyncHandler } from "../utils/asyncHandler";
import { getRole, getUserId, requireRole } from "../utils/db";

const router = Router();
router.use(requireAuth);

const idParamsSchema = z.object({
  id: z.string().uuid("ID percakapan tidak valid"),
});

const createConversationSchema = z
  .object({
    dokterId: z.string().uuid("ID dokter tidak valid"),
    subject: z.string().trim().min(1).max(160).optional().nullable(),
    appointmentId: z.string().uuid("ID appointment tidak valid").optional().nullable(),
  })
  .strict();

const sendMessageSchema = z
  .object({
    body: z.string().trim().min(1, "Pesan tidak boleh kosong").max(2000),
  })
  .strict();

router.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const role = getRole(req);
    if (!role) {
      res.status(403).json({ error: { message: "Role tidak valid untuk chat" } });
      return;
    }

    const items = await listChatConversations(getUserId(req), role);
    res.json({ items, serverTime: new Date().toISOString() });
  }),
);

router.post(
  "/conversations",
  asyncHandler(async (req, res) => {
    requireRole(req, "pasien");
    const body = createConversationSchema.parse(req.body);

    const conversation = await createChatConversation({
      pasienId: getUserId(req),
      dokterId: body.dokterId,
      subject: body.subject,
      appointmentId: body.appointmentId,
    });

    res.status(201).json({ conversation });
  }),
);

router.post(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = sendMessageSchema.parse(req.body);
    const result = await sendChatMessage(id, getUserId(req), body.body);

    res.status(201).json(result);
  }),
);

router.patch(
  "/conversations/:id/read",
  asyncHandler(async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const result = await markChatConversationRead(id, getUserId(req));

    res.json(result);
  }),
);

export default router;
