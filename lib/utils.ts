import {
  LOCATIONS,
  TEAMS,
  type Location,
  type LocationSlug,
  type TeamSlug,
} from "./supabase";

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  const dateOpts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return `${d.toLocaleDateString([], dateOpts)} · ${time}`;
}

// First @-tagged location whose canonical name appears in the text
// (case-insensitive, requires the full name with internal spaces).
export function detectLocationInText(text: string): LocationSlug | null {
  const lower = text.toLowerCase();
  for (const l of LOCATIONS) {
    if (lower.includes(`@${l.name.toLowerCase()}`)) return l.slug;
  }
  return null;
}

// Replace every "@LocName" (case-insensitive) with "📍 LocName" using the
// canonical capitalization. Used for push notification bodies and any other
// text-only renderings where we can't render a styled inline pill.
export function expandLocationTags(text: string): string {
  let out = text;
  for (const l of LOCATIONS) {
    const needle = `@${l.name}`;
    const lowerNeedle = needle.toLowerCase();
    let lower = out.toLowerCase();
    let idx = lower.indexOf(lowerNeedle);
    while (idx !== -1) {
      out = out.slice(0, idx) + `📍 ${l.name}` + out.slice(idx + needle.length);
      lower = out.toLowerCase();
      idx = lower.indexOf(lowerNeedle, idx + 1);
    }
  }
  return out;
}

export function alertTone(message: string): "panic" | "standdown" | "beep" {
  if (/^PANIC\b/i.test(message)) return "panic";
  if (/^STAND DOWN\b/i.test(message)) return "standdown";
  return "beep";
}

export function teamName(slug: TeamSlug | string): string {
  const t = TEAMS.find((x) => x.slug === slug);
  return t ? t.name : slug;
}

// Pick the closest known location to (lat, lng), but only if it's within
// `maxMeters` (default 500m). Skips locations without coords. Returns null
// when the sender is too far from any known location — that prevents an
// alert from auto-tagging a far-away church location just because it
// happens to be the least-far one.
export function nearestLocationTo(
  lat: number,
  lng: number,
  locations: Location[] = LOCATIONS,
  maxMeters: number = 500
): LocationSlug | null {
  let best: { slug: LocationSlug; meters: number } | null = null;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (const l of locations) {
    if (l.latitude == null || l.longitude == null) continue;
    const dLatM = (l.latitude - lat) * 111_000;
    const dLngM = (l.longitude - lng) * 111_000 * cosLat;
    const meters = Math.sqrt(dLatM * dLatM + dLngM * dLngM);
    if (!best || meters < best.meters) best = { slug: l.slug, meters };
  }
  if (!best || best.meters > maxMeters) return null;
  return best.slug;
}
