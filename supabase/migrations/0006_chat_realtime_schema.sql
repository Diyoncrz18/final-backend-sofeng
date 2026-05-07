-- Realtime chat dokter-pasien.

create table if not exists public.chat_conversations (
  id                uuid primary key default gen_random_uuid(),
  pasien_id         uuid not null,
  dokter_id         uuid not null,
  appointment_id    uuid,
  subject           text,
  status            text not null default 'aktif' check (status in ('aktif', 'ditutup')),
  last_message_at   timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint chat_conversations_pasien_id_fkey
    foreign key (pasien_id) references public.pasien_profiles(id) on delete cascade,
  constraint chat_conversations_dokter_id_fkey
    foreign key (dokter_id) references public.dokter_profiles(id) on delete restrict,
  constraint chat_conversations_appointment_id_fkey
    foreign key (appointment_id) references public.appointments(id) on delete set null
);

create table if not exists public.chat_messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null,
  sender_id         uuid not null,
  body              text not null check (char_length(trim(body)) between 1 and 2000),
  read_at           timestamptz,
  created_at        timestamptz not null default now(),

  constraint chat_messages_conversation_id_fkey
    foreign key (conversation_id) references public.chat_conversations(id) on delete cascade,
  constraint chat_messages_sender_id_fkey
    foreign key (sender_id) references public.profiles(id) on delete cascade
);

create index if not exists idx_chat_conversations_pasien
  on public.chat_conversations(pasien_id, last_message_at desc);

create index if not exists idx_chat_conversations_dokter
  on public.chat_conversations(dokter_id, last_message_at desc);

create index if not exists idx_chat_messages_conversation
  on public.chat_messages(conversation_id, created_at asc);

create index if not exists idx_chat_messages_unread
  on public.chat_messages(conversation_id, sender_id, created_at desc)
  where read_at is null;

alter table public.chat_conversations enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists chat_conversations_select_own on public.chat_conversations;
create policy chat_conversations_select_own on public.chat_conversations
  for select to authenticated
  using (auth.uid() = pasien_id or auth.uid() = dokter_id);

drop policy if exists chat_messages_select_own on public.chat_messages;
create policy chat_messages_select_own on public.chat_messages
  for select to authenticated
  using (
    exists (
      select 1
      from public.chat_conversations c
      where c.id = conversation_id
        and (c.pasien_id = auth.uid() or c.dokter_id = auth.uid())
    )
  );

drop policy if exists chat_messages_update_read_own on public.chat_messages;
create policy chat_messages_update_read_own on public.chat_messages
  for update to authenticated
  using (
    exists (
      select 1
      from public.chat_conversations c
      where c.id = conversation_id
        and (c.pasien_id = auth.uid() or c.dokter_id = auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.chat_conversations c
      where c.id = conversation_id
        and (c.pasien_id = auth.uid() or c.dokter_id = auth.uid())
    )
  );
