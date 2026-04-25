import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const hasSupabaseConfig = Boolean(url && anonKey);

export const supabase = createClient(
  url || "https://placeholder.supabase.co",
  anonKey || "placeholder-anon-key"
);

export const DEMO_JOIN_CODE = "CHURCH1";
export const NAME_STORAGE_KEY = "church-alert:name";
export const LAST_KNOWN_POS_KEY = "church-alert:lastKnownPos";
export const CHAT_MUTED_KEY = "church-alert:chatMuted";
export const joinedTeamsKey = (churchId: string) => `church-alert:joined:${churchId}`;
export const activeTeamKey = (churchId: string) => `church-alert:active:${churchId}`;

export type TeamSlug =
  | "worship"
  | "ushers"
  | "greeters"
  | "kids"
  | "youth"
  | "media"
  | "security"
  | "hospitality"
  | "prayer";

export type Team = { slug: TeamSlug; name: string };

export const TEAMS: Team[] = [
  { slug: "worship", name: "Worship" },
  { slug: "ushers", name: "Ushers" },
  { slug: "greeters", name: "Greeters" },
  { slug: "kids", name: "Kids" },
  { slug: "youth", name: "Youth" },
  { slug: "media", name: "Media / AV" },
  { slug: "security", name: "Security" },
  { slug: "hospitality", name: "Hospitality" },
  { slug: "prayer", name: "Prayer" },
];

const TEAM_SLUGS = new Set<TeamSlug>(TEAMS.map((t) => t.slug));

export function teamBySlug(slug: TeamSlug): Team {
  const t = TEAMS.find((x) => x.slug === slug);
  if (!t) throw new Error(`Unknown team slug: ${slug}`);
  return t;
}

export function isTeamSlug(v: unknown): v is TeamSlug {
  return typeof v === "string" && TEAM_SLUGS.has(v as TeamSlug);
}

export type LocationSlug =
  | "main_sanctuary"
  | "main_sanctuary_entrance"
  | "kd_ellis_hall"
  | "kids_sanctuary"
  | "parking_lot_front"
  | "parking_lot_back";

export type Location = {
  slug: LocationSlug;
  name: string;
  // Optional anchor coords. Used to pick the nearest location when an alert
  // includes GPS but no explicit @-tag. Placeholder values for the demo
  // church — survey and replace with real points before scaling.
  latitude?: number;
  longitude?: number;
};

export const LOCATIONS: Location[] = [
  { slug: "main_sanctuary", name: "Main Sanctuary", latitude: 29.6794, longitude: -95.3940 },
  { slug: "main_sanctuary_entrance", name: "Main Sanctuary Entrance", latitude: 29.67945, longitude: -95.39395 },
  { slug: "kd_ellis_hall", name: "KD Ellis Hall", latitude: 29.6793, longitude: -95.39405 },
  { slug: "kids_sanctuary", name: "Kids Sanctuary", latitude: 29.67945, longitude: -95.39415 },
  { slug: "parking_lot_front", name: "Parking Lot Front", latitude: 29.6796, longitude: -95.3940 },
  { slug: "parking_lot_back", name: "Parking Lot Back", latitude: 29.6792, longitude: -95.3940 },
];

const LOCATION_SLUGS = new Set<LocationSlug>(LOCATIONS.map((l) => l.slug));

export function locationBySlug(slug: LocationSlug): Location {
  const l = LOCATIONS.find((x) => x.slug === slug);
  if (!l) throw new Error(`Unknown location slug: ${slug}`);
  return l;
}

export function isLocationSlug(v: unknown): v is LocationSlug {
  return typeof v === "string" && LOCATION_SLUGS.has(v as LocationSlug);
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
