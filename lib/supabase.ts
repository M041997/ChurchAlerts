import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const hasSupabaseConfig = Boolean(url && anonKey);
export const supabaseConfigMessage =
  "Supabase is not configured. In Vercel, set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then redeploy.";

export const supabase = createClient(
  url || "https://placeholder.supabase.co",
  anonKey || "placeholder-anon-key"
);

export const DEMO_JOIN_CODE = "CHURCH1";
export const NAME_STORAGE_KEY = "church-alert:name";
export const LAST_KNOWN_POS_KEY = "church-alert:lastKnownPos";
export const CHAT_MUTED_KEY = "church-alert:chatMuted";
export const JOINED_CHURCH_KEY = "church-alert:joinedChurch";
export const JOIN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const joinedTeamsKey = (churchId: string) => `church-alert:joined:${churchId}`;
export const activeTeamKey = (churchId: string) => `church-alert:active:${churchId}`;

// Slugs are stored as plain strings now that teams and locations are
// configurable per-church. Use the church's loaded list to look them up
// — there is no global "all teams in the world" set.
export type TeamSlug = string;
export type LocationSlug = string;

export type Team = {
  slug: TeamSlug;
  name: string;
  sort_order?: number;
};

export type Location = {
  slug: LocationSlug;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  sort_order?: number;
};

// Default seed list used when create_church is called server-side. The
// chat reads each church's *own* church_teams / church_locations rows
// at runtime — these arrays are never the source of truth in the UI.
export const DEFAULT_TEAMS: Team[] = [
  { slug: "pastors", name: "Pastors", sort_order: 5 },
  { slug: "worship", name: "Worship", sort_order: 10 },
  { slug: "ushers", name: "Ushers", sort_order: 20 },
  { slug: "greeters", name: "Greeters", sort_order: 30 },
  { slug: "kids", name: "Kids", sort_order: 40 },
  { slug: "youth", name: "Youth", sort_order: 50 },
  { slug: "media", name: "Media / AV", sort_order: 60 },
  { slug: "security", name: "Security", sort_order: 70 },
  { slug: "hospitality", name: "Hospitality", sort_order: 80 },
  { slug: "prayer", name: "Prayer", sort_order: 90 },
];

export const DEFAULT_LOCATIONS: Location[] = [
  { slug: "main_sanctuary", name: "Main Sanctuary", sort_order: 10 },
  { slug: "main_sanctuary_entrance", name: "Main Sanctuary Entrance", sort_order: 20 },
  { slug: "fellowship_hall", name: "Fellowship Hall", sort_order: 30 },
  { slug: "kids_sanctuary", name: "Kids Sanctuary", sort_order: 40 },
  { slug: "parking_lot_front", name: "Parking Lot Front", sort_order: 50 },
  { slug: "parking_lot_back", name: "Parking Lot Back", sort_order: 60 },
];

// Convert a free-text label like "Main Hall" into a stable slug
// (lowercase, underscored, alphanumerics only) for use in the
// church_teams / church_locations primary key.
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export type Message = {
  id: string;
  church_id: string;
  team_slug: TeamSlug | null;
  location: LocationSlug | null;
  latitude: number | null;
  longitude: number | null;
  message: string;
  sender_name: string;
  is_alert: boolean;
  created_at: string;
};
