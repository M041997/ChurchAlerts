import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const hasSupabaseConfig = Boolean(url && anonKey);

export const supabase = createClient(
  url || "https://placeholder.supabase.co",
  anonKey || "placeholder-anon-key"
);

export type Message = {
  id: string;
  group_id: string;
  message: string;
  sender_name: string;
  is_alert: boolean;
  created_at: string;
};

export const DEMO_JOIN_CODE = "CHURCH1";
export const NAME_STORAGE_KEY = "church-alert:name";
