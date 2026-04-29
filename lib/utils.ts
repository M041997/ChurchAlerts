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

// Capture a current GPS fix with a hard deadline. Resolves to null if the
// browser refuses, the user denies, or the satellite lock takes too long.
// Panic buttons can't wait — better to ship the alert without coords than
// to hang the UI for 30s waiting on a slow fix.
export async function getQuickPosition(
  timeoutMs = 5000,
  maxCacheAgeMs = 60_000
): Promise<{ latitude: number; longitude: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { latitude: number; longitude: number } | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        finish({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
      },
      () => {
        clearTimeout(timer);
        finish(null);
      },
      {
        enableHighAccuracy: true,
        timeout: Math.max(500, timeoutMs - 100),
        maximumAge: maxCacheAgeMs,
      }
    );
  });
}

// Background-warm the browser's geolocation cache so the next
// getQuickPosition() call has a recent fix sitting in maximumAge.
export function primeGeolocation(): void {
  if (typeof navigator === "undefined" || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    () => {},
    () => {},
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
  );
}

const LAST_POS_KEY = "church-alert:lastPos";
type StoredPos = { latitude: number; longitude: number; ts: number };

// Cap the fallback at this age — better to send no coords than coords from
// before the user moved across town.
const STALE_AFTER_MS = 10 * 60 * 1000;

export function readLastKnownPos(): StoredPos | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPos;
    if (
      typeof parsed.latitude !== "number" ||
      typeof parsed.longitude !== "number" ||
      typeof parsed.ts !== "number"
    )
      return null;
    if (Date.now() - parsed.ts > STALE_AFTER_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLastKnownPos(pos: StoredPos) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_POS_KEY, JSON.stringify(pos));
  } catch {
    /* quota / private mode — ignore */
  }
}

// Keep a live GPS watch open while the chat is mounted, persisting every
// fresh fix to localStorage. This way a panic can always fall back to the
// most-recent-known coordinates even if the satellite lock momentarily
// drops or the user's permission state flips. Returns a cleanup fn.
export function startGeoWatch(): () => void {
  if (typeof navigator === "undefined" || !navigator.geolocation) return () => {};
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      writeLastKnownPos({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        ts: Date.now(),
      });
    },
    () => {
      /* permission errors handled elsewhere via permissions API */
    },
    { enableHighAccuracy: true, maximumAge: 30_000, timeout: 30_000 }
  );
  return () => {
    try {
      navigator.geolocation.clearWatch(id);
    } catch {
      /* already cleared */
    }
  };
}

// Best-effort coords for a panic: try a fresh-or-recent fix first, then
// fall back to whatever we cached during the live watch.
export async function bestPanicCoords(): Promise<
  { latitude: number; longitude: number } | null
> {
  const live = await getQuickPosition(5000, 5 * 60_000);
  if (live) return live;
  return readLastKnownPos();
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
