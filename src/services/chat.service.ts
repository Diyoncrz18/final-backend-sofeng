import { randomUUID } from "crypto";

import { isDevelopment, isProduction } from "../config/env";
import { supabaseAdmin } from "../config/supabase";
import { ApiError } from "../utils/ApiError";

export type ChatRole = "pasien" | "dokter";

export type ChatProfileSummary = {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
};

export type ChatConversation = {
  id: string;
  pasien_id: string;
  dokter_id: string;
  appointment_id: string | null;
  subject: string | null;
  status: "aktif" | "ditutup";
  last_message_at: string;
  created_at: string;
  updated_at: string;
  pasien: {
    id: string;
    profile: ChatProfileSummary | null;
  } | null;
  dokter: {
    id: string;
    spesialisasi: string | null;
    profile: ChatProfileSummary | null;
  } | null;
  appointment: {
    id: string;
    tanggal: string;
    jam: string;
    jenis: string;
    status: string;
    keluhan: string | null;
  } | null;
  messages: ChatMessage[];
  unreadCount: number;
  lastMessage: ChatMessage | null;
};

type RawRelation<T> = T | T[] | null;

type RawChatConversationRow = {
  id: string;
  pasien_id: string;
  dokter_id: string;
  appointment_id: string | null;
  subject: string | null;
  status: "aktif" | "ditutup";
  last_message_at: string;
  created_at: string;
  updated_at: string;
  pasien: RawRelation<{
    id: string;
    profile: RawRelation<ChatProfileSummary>;
  }>;
  dokter: RawRelation<{
    id: string;
    spesialisasi: string | null;
    profile: RawRelation<ChatProfileSummary>;
  }>;
  appointment: RawRelation<{
    id: string;
    tanggal: string;
    jam: string;
    jenis: string;
    status: string;
    keluhan: string | null;
  }>;
};

const CONVERSATION_SELECT = `
  id,
  pasien_id,
  dokter_id,
  appointment_id,
  subject,
  status,
  last_message_at,
  created_at,
  updated_at,
  pasien:pasien_profiles!chat_conversations_pasien_id_fkey (
    id,
    profile:profiles!inner ( id, full_name, avatar_url )
  ),
  dokter:dokter_profiles!chat_conversations_dokter_id_fkey (
    id,
    spesialisasi,
    profile:profiles!inner ( id, full_name, avatar_url )
  ),
  appointment:appointments!chat_conversations_appointment_id_fkey (
    id,
    tanggal,
    jam,
    jenis,
    status,
    keluhan
  )
`;

const MESSAGE_SELECT = "id, conversation_id, sender_id, body, read_at, created_at";

const volatileConversations = new Map<string, ChatConversation>();

function isRlsOrMissingChatSchemaError(error: { message?: string } | null | undefined) {
  const message = error?.message ?? "";
  return /row-level security|chat_conversations|chat_messages|schema cache|Could not find the table/i.test(
    message,
  );
}

function canUseVolatileChatFallback() {
  return isDevelopment && !isProduction;
}

function cloneConversation(conversation: ChatConversation, viewerId?: string): ChatConversation {
  const messages = [...conversation.messages].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  return {
    ...conversation,
    messages,
    unreadCount: viewerId
      ? messages.filter((message) => message.sender_id !== viewerId && !message.read_at).length
      : conversation.unreadCount,
    lastMessage: messages[messages.length - 1] ?? null,
  };
}

function firstOrNull<T>(value: RawRelation<T> | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function normalizeConversation(
  row: RawChatConversationRow,
  messages: ChatMessage[] = [],
  viewerId?: string,
): ChatConversation {
  const pasien = firstOrNull(row.pasien);
  const dokter = firstOrNull(row.dokter);
  const appointment = firstOrNull(row.appointment);
  const sortedMessages = [...messages].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );

  return {
    id: row.id,
    pasien_id: row.pasien_id,
    dokter_id: row.dokter_id,
    appointment_id: row.appointment_id,
    subject: row.subject,
    status: row.status,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    pasien: pasien
      ? {
          id: pasien.id,
          profile: firstOrNull(pasien.profile),
        }
      : null,
    dokter: dokter
      ? {
          id: dokter.id,
          spesialisasi: dokter.spesialisasi,
          profile: firstOrNull(dokter.profile),
        }
      : null,
    appointment: appointment
      ? {
          id: appointment.id,
          tanggal: appointment.tanggal,
          jam: appointment.jam,
          jenis: appointment.jenis,
          status: appointment.status,
          keluhan: appointment.keluhan,
        }
      : null,
    messages: sortedMessages,
    unreadCount: viewerId
      ? sortedMessages.filter((message) => message.sender_id !== viewerId && !message.read_at)
          .length
      : 0,
    lastMessage: sortedMessages[sortedMessages.length - 1] ?? null,
  };
}

async function loadConversationById(
  conversationId: string,
  viewerId?: string,
): Promise<ChatConversation> {
  const volatile = volatileConversations.get(conversationId);
  if (volatile) {
    return cloneConversation(volatile, viewerId);
  }

  const { data, error } = await supabaseAdmin
    .from("chat_conversations")
    .select(CONVERSATION_SELECT)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) {
    throw ApiError.badRequest(`Gagal ambil percakapan: ${error.message}`);
  }
  if (!data) {
    throw ApiError.notFound("Percakapan tidak ditemukan");
  }

  return normalizeConversation(data as unknown as RawChatConversationRow, [], viewerId);
}

export async function assertChatConversationAccess(
  conversationId: string,
  userId: string,
): Promise<ChatConversation> {
  const conversation = await loadConversationById(conversationId, userId);
  if (conversation.pasien_id !== userId && conversation.dokter_id !== userId) {
    throw ApiError.forbidden("Anda tidak punya akses ke percakapan ini");
  }
  return conversation;
}

export async function listChatConversations(
  userId: string,
  role: ChatRole,
): Promise<ChatConversation[]> {
  const ownerColumn = role === "dokter" ? "dokter_id" : "pasien_id";
  const { data, error } = await supabaseAdmin
    .from("chat_conversations")
    .select(CONVERSATION_SELECT)
    .eq(ownerColumn, userId)
    .order("last_message_at", { ascending: false });

  if (error) {
    if (canUseVolatileChatFallback() && isRlsOrMissingChatSchemaError(error)) {
      return listVolatileChatConversations(userId, role);
    }
    throw ApiError.badRequest(`Gagal ambil daftar chat: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as RawChatConversationRow[];
  const conversationIds = rows.map((row) => row.id);
  const messagesByConversation = new Map<string, ChatMessage[]>();

  if (conversationIds.length > 0) {
    const { data: messageRows, error: messageError } = await supabaseAdmin
      .from("chat_messages")
      .select(MESSAGE_SELECT)
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: true });

    if (messageError) {
      throw ApiError.badRequest(`Gagal ambil pesan chat: ${messageError.message}`);
    }

    for (const message of (messageRows ?? []) as ChatMessage[]) {
      const current = messagesByConversation.get(message.conversation_id) ?? [];
      current.push(message);
      messagesByConversation.set(message.conversation_id, current);
    }
  }

  return sortConversations([
    ...rows.map((row) =>
      normalizeConversation(row, messagesByConversation.get(row.id) ?? [], userId),
    ),
    ...listVolatileChatConversations(userId, role),
  ]);
}

export async function createChatConversation(input: {
  pasienId: string;
  dokterId: string;
  subject?: string | null;
  appointmentId?: string | null;
}): Promise<ChatConversation> {
  // Pastikan row pasien_profiles ada — buat jika belum ada.
  // Pakai check-then-insert agar lebih robust (upsert kadang trigger RLS
  // di beberapa versi Supabase meskipun pakai service_role).
  const { data: existingPasien } = await supabaseAdmin
    .from("pasien_profiles")
    .select("id")
    .eq("id", input.pasienId)
    .maybeSingle();

  if (!existingPasien) {
    const { error: ensurePatientError } = await supabaseAdmin
      .from("pasien_profiles")
      .insert({ id: input.pasienId });

    // Jika error karena duplicate (race condition), abaikan — row sudah ada.
    if (ensurePatientError && !ensurePatientError.message.includes("duplicate")) {
      throw ApiError.badRequest(`Gagal menyiapkan profil pasien: ${ensurePatientError.message}`);
    }
  }

  const { data: dokter, error: dokterError } = await supabaseAdmin
    .from("dokter_profiles")
    .select("id")
    .eq("id", input.dokterId)
    .maybeSingle();

  if (dokterError) {
    throw ApiError.badRequest(`Gagal validasi dokter: ${dokterError.message}`);
  }
  if (!dokter) {
    throw ApiError.notFound("Dokter tidak ditemukan");
  }

  let existingQuery = supabaseAdmin
    .from("chat_conversations")
    .select("id")
    .eq("pasien_id", input.pasienId)
    .eq("dokter_id", input.dokterId)
    .eq("status", "aktif")
    .limit(1);

  if (input.appointmentId) {
    existingQuery = existingQuery.eq("appointment_id", input.appointmentId);
  } else {
    existingQuery = existingQuery.is("appointment_id", null);
  }

  const { data: existingRows, error: existingError } = await existingQuery;
  if (existingError) {
    throw ApiError.badRequest(`Gagal cek percakapan aktif: ${existingError.message}`);
  }

  const existing = existingRows?.[0] as { id: string } | undefined;
  if (existing) {
    return loadConversationById(existing.id, input.pasienId);
  }

  const { data: created, error: createError } = await supabaseAdmin
    .from("chat_conversations")
    .insert({
      pasien_id: input.pasienId,
      dokter_id: input.dokterId,
      appointment_id: input.appointmentId ?? null,
      subject: input.subject?.trim() || "Konsultasi online",
      status: "aktif",
      last_message_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if ((createError || !created) && canUseVolatileChatFallback() && isRlsOrMissingChatSchemaError(createError)) {
    console.warn(
      "[chat] menggunakan fallback volatile karena insert chat_conversations gagal:",
      createError?.message ?? "unknown",
    );
    return createVolatileChatConversation(input);
  }

  if (createError || !created) {
    throw ApiError.badRequest(
      `Gagal membuat percakapan: ${createError?.message ?? "unknown"}`,
    );
  }

  return loadConversationById((created as { id: string }).id, input.pasienId);
}

export async function sendChatMessage(
  conversationId: string,
  senderId: string,
  body: string,
): Promise<{
  message: ChatMessage;
  conversation: ChatConversation;
  recipientId: string;
}> {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    throw ApiError.badRequest("Pesan tidak boleh kosong");
  }
  if (trimmedBody.length > 2000) {
    throw ApiError.unprocessable("Pesan maksimal 2000 karakter");
  }

  const volatile = volatileConversations.get(conversationId);
  if (volatile) {
    return sendVolatileChatMessage(conversationId, senderId, trimmedBody);
  }

  const access = await assertChatConversationAccess(conversationId, senderId);
  if (access.status !== "aktif") {
    throw ApiError.conflict("Percakapan sudah ditutup");
  }

  const { data, error } = await supabaseAdmin
    .from("chat_messages")
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      body: trimmedBody,
    })
    .select(MESSAGE_SELECT)
    .single();

  if (error || !data) {
    throw ApiError.badRequest(`Gagal mengirim pesan: ${error?.message ?? "unknown"}`);
  }

  const now = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from("chat_conversations")
    .update({ last_message_at: now, updated_at: now })
    .eq("id", conversationId);

  if (updateError) {
    throw ApiError.badRequest(`Gagal update percakapan: ${updateError.message}`);
  }

  const conversation = await loadConversationById(conversationId, senderId);
  const recipientId = access.pasien_id === senderId ? access.dokter_id : access.pasien_id;

  return {
    message: data as ChatMessage,
    conversation,
    recipientId,
  };
}

export async function markChatConversationRead(
  conversationId: string,
  userId: string,
): Promise<{ readAt: string }> {
  const volatile = volatileConversations.get(conversationId);
  if (volatile) {
    return markVolatileChatConversationRead(conversationId, userId);
  }

  await assertChatConversationAccess(conversationId, userId);
  const readAt = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("chat_messages")
    .update({ read_at: readAt })
    .eq("conversation_id", conversationId)
    .neq("sender_id", userId)
    .is("read_at", null);

  if (error) {
    throw ApiError.badRequest(`Gagal menandai pesan dibaca: ${error.message}`);
  }

  return { readAt };
}

function sortConversations(items: ChatConversation[]) {
  return [...items].sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
}

function listVolatileChatConversations(userId: string, role: ChatRole) {
  const ownerColumn = role === "dokter" ? "dokter_id" : "pasien_id";
  return sortConversations(
    [...volatileConversations.values()]
      .filter((conversation) => conversation[ownerColumn] === userId)
      .map((conversation) => cloneConversation(conversation, userId)),
  );
}

async function loadProfileSummary(userId: string): Promise<ChatProfileSummary | null> {
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, avatar_url")
    .eq("id", userId)
    .maybeSingle();

  return (data as ChatProfileSummary | null) ?? null;
}

async function loadDoctorSummary(dokterId: string): Promise<ChatConversation["dokter"]> {
  const { data } = await supabaseAdmin
    .from("dokter_profiles")
    .select("id, spesialisasi, profile:profiles!inner ( id, full_name, avatar_url )")
    .eq("id", dokterId)
    .maybeSingle();

  const row = data as
    | {
        id: string;
        spesialisasi: string | null;
        profile: RawRelation<ChatProfileSummary>;
      }
    | null;

  if (!row) return null;
  return {
    id: row.id,
    spesialisasi: row.spesialisasi,
    profile: firstOrNull(row.profile),
  };
}

async function createVolatileChatConversation(input: {
  pasienId: string;
  dokterId: string;
  subject?: string | null;
  appointmentId?: string | null;
}): Promise<ChatConversation> {
  const existing = [...volatileConversations.values()].find(
    (conversation) =>
      conversation.pasien_id === input.pasienId &&
      conversation.dokter_id === input.dokterId &&
      conversation.status === "aktif" &&
      conversation.appointment_id === (input.appointmentId ?? null),
  );
  if (existing) return cloneConversation(existing, input.pasienId);

  const now = new Date().toISOString();
  const conversation: ChatConversation = {
    id: randomUUID(),
    pasien_id: input.pasienId,
    dokter_id: input.dokterId,
    appointment_id: input.appointmentId ?? null,
    subject: input.subject?.trim() || "Konsultasi online",
    status: "aktif",
    last_message_at: now,
    created_at: now,
    updated_at: now,
    pasien: {
      id: input.pasienId,
      profile: await loadProfileSummary(input.pasienId),
    },
    dokter: await loadDoctorSummary(input.dokterId),
    appointment: null,
    messages: [],
    unreadCount: 0,
    lastMessage: null,
  };

  volatileConversations.set(conversation.id, conversation);
  return cloneConversation(conversation, input.pasienId);
}

function getVolatileConversationOrThrow(conversationId: string, userId: string) {
  const conversation = volatileConversations.get(conversationId);
  if (!conversation) throw ApiError.notFound("Percakapan tidak ditemukan");
  if (conversation.pasien_id !== userId && conversation.dokter_id !== userId) {
    throw ApiError.forbidden("Anda tidak punya akses ke percakapan ini");
  }
  return conversation;
}

function sendVolatileChatMessage(
  conversationId: string,
  senderId: string,
  body: string,
): {
  message: ChatMessage;
  conversation: ChatConversation;
  recipientId: string;
} {
  const conversation = getVolatileConversationOrThrow(conversationId, senderId);
  if (conversation.status !== "aktif") {
    throw ApiError.conflict("Percakapan sudah ditutup");
  }

  const now = new Date().toISOString();
  const message: ChatMessage = {
    id: randomUUID(),
    conversation_id: conversationId,
    sender_id: senderId,
    body,
    read_at: null,
    created_at: now,
  };

  conversation.messages = [...conversation.messages, message];
  conversation.last_message_at = now;
  conversation.updated_at = now;
  conversation.lastMessage = message;
  volatileConversations.set(conversationId, conversation);

  return {
    message,
    conversation: cloneConversation(conversation, senderId),
    recipientId: conversation.pasien_id === senderId ? conversation.dokter_id : conversation.pasien_id,
  };
}

function markVolatileChatConversationRead(
  conversationId: string,
  userId: string,
): { readAt: string } {
  const conversation = getVolatileConversationOrThrow(conversationId, userId);
  const readAt = new Date().toISOString();
  conversation.messages = conversation.messages.map((message) =>
    message.sender_id !== userId && !message.read_at ? { ...message, read_at: readAt } : message,
  );
  conversation.lastMessage = conversation.messages[conversation.messages.length - 1] ?? null;
  volatileConversations.set(conversationId, conversation);
  return { readAt };
}
