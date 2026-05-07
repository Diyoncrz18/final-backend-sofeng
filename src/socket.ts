import type { Server as HttpServer } from "http";

import { Server, type Socket } from "socket.io";

import { env } from "./config/env";
import { createSupabaseUserClient } from "./config/supabase";
import {
  assertChatConversationAccess,
  markChatConversationRead,
  sendChatMessage,
} from "./services/chat.service";
import { ApiError } from "./utils/ApiError";
import type { Role } from "./utils/db";

type SocketUser = {
  userId: string;
  role: Role;
};

type ChatAck = (payload: Record<string, unknown>) => void;

function messageFromError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Terjadi kesalahan pada chat realtime";
}

function getSocketUser(socket: Socket): SocketUser {
  return socket.data.user as SocketUser;
}

function conversationRoom(conversationId: string) {
  return `chat:${conversationId}`;
}

function userRoom(userId: string) {
  return `user:${userId}`;
}

export function attachSocketServer(server: HttpServer) {
  const io = new Server(server, {
    cors: {
      origin: env.ALLOWED_ORIGINS,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || !token.trim()) {
        next(new Error("Missing bearer token"));
        return;
      }

      const { data, error } = await createSupabaseUserClient(token.trim()).auth.getUser();
      if (error || !data?.user) {
        next(new Error(error?.message ?? "Invalid or expired token"));
        return;
      }

      const role = data.user.user_metadata?.role;
      if (role !== "pasien" && role !== "dokter") {
        next(new Error("Role tidak valid untuk chat realtime"));
        return;
      }

      socket.data.user = {
        userId: data.user.id,
        role,
      } satisfies SocketUser;
      next();
    } catch (error) {
      next(new Error(messageFromError(error)));
    }
  });

  io.on("connection", (socket) => {
    const user = getSocketUser(socket);
    socket.join(userRoom(user.userId));

    socket.on(
      "chat:join",
      async (
        payload: { conversationId?: unknown },
        ack?: ChatAck,
      ) => {
        try {
          const conversationId = payload.conversationId;
          if (typeof conversationId !== "string" || !conversationId) {
            throw ApiError.badRequest("ID percakapan tidak valid");
          }

          await assertChatConversationAccess(conversationId, user.userId);
          socket.join(conversationRoom(conversationId));
          ack?.({ ok: true, conversationId });
        } catch (error) {
          ack?.({ ok: false, error: messageFromError(error) });
        }
      },
    );

    socket.on(
      "chat:conversation:created",
      async (
        payload: { conversationId?: unknown },
        ack?: ChatAck,
      ) => {
        try {
          const conversationId = payload.conversationId;
          if (typeof conversationId !== "string" || !conversationId) {
            throw ApiError.badRequest("ID percakapan tidak valid");
          }

          const conversation = await assertChatConversationAccess(
            conversationId,
            user.userId,
          );
          const recipientId =
            conversation.pasien_id === user.userId
              ? conversation.dokter_id
              : conversation.pasien_id;

          socket.join(conversationRoom(conversationId));
          io.to(userRoom(recipientId)).emit("chat:conversation", conversation);
          io.to(conversationRoom(conversationId)).emit("chat:conversation", conversation);
          ack?.({ ok: true, conversation });
        } catch (error) {
          ack?.({ ok: false, error: messageFromError(error) });
        }
      },
    );

    socket.on(
      "chat:send",
      async (
        payload: { conversationId?: unknown; body?: unknown },
        ack?: ChatAck,
      ) => {
        try {
          const { conversationId, body } = payload;
          if (typeof conversationId !== "string" || !conversationId) {
            throw ApiError.badRequest("ID percakapan tidak valid");
          }
          if (typeof body !== "string") {
            throw ApiError.badRequest("Pesan tidak valid");
          }

          const result = await sendChatMessage(conversationId, user.userId, body);
          io.to(conversationRoom(conversationId)).emit("chat:message", result);
          io.to(userRoom(result.recipientId)).emit("chat:message", result);
          io.to(userRoom(result.recipientId)).emit("chat:conversation", result.conversation);
          ack?.({ ok: true, ...result });
        } catch (error) {
          ack?.({ ok: false, error: messageFromError(error) });
        }
      },
    );

    socket.on(
      "chat:typing",
      (payload: { conversationId?: unknown; isTyping?: unknown }) => {
        const { conversationId, isTyping } = payload;
        if (typeof conversationId !== "string") return;

        socket.to(conversationRoom(conversationId)).emit("chat:typing", {
          conversationId,
          userId: user.userId,
          isTyping: Boolean(isTyping),
        });
      },
    );

    socket.on(
      "chat:read",
      async (
        payload: { conversationId?: unknown },
        ack?: ChatAck,
      ) => {
        try {
          const conversationId = payload.conversationId;
          if (typeof conversationId !== "string" || !conversationId) {
            throw ApiError.badRequest("ID percakapan tidak valid");
          }

          const result = await markChatConversationRead(conversationId, user.userId);
          io.to(conversationRoom(conversationId)).emit("chat:read", {
            conversationId,
            userId: user.userId,
            readAt: result.readAt,
          });
          ack?.({ ok: true, ...result });
        } catch (error) {
          ack?.({ ok: false, error: messageFromError(error) });
        }
      },
    );
  });

  return io;
}
