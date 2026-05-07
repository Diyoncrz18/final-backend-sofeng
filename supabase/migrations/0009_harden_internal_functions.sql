-- =====================================================================
-- 0009_harden_internal_functions.sql
-- ---------------------------------------------------------------------
-- Hardening fungsi internal setelah recovery schema:
--   1. set_updated_at memakai search_path eksplisit.
--   2. handle_new_user tidak bisa dipanggil via REST/RPC publik.
--   3. current_user_role tetap bisa dipakai authenticated untuk RLS.
-- =====================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.current_user_role() from public, anon;
grant execute on function public.current_user_role() to authenticated;

-- =====================================================================
-- DONE.
-- =====================================================================
