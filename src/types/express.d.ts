import type { User } from "@supabase/supabase-js";

/**
 * Augmentasi `Express.Request` agar setelah `requireAuth` middleware,
 * properti `user` dan `accessToken` tersedia & type-safe.
 */
declare global {
  namespace Express {
    interface Request {
      user?: User;
      accessToken?: string;
    }
  }
}

export {};
