import type { Location, LocationSlug, Team, TeamSlug } from "./supabase";

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
// Locations are now per-church, so the caller passes the relevant set.
export function detectLocationInText(
  text: string,
  locations: Location[]
): LocationSlug | null {
  const lower = text.toLowerCase();
  // Match longer names first so "@Main Sanctuary Entrance" doesn't get
  // truncated to a "@Main Sanctuary" match.
  const sorted = [...locations].sort(
    (a, b) => b.name.length - a.name.length
  );
  for (const l of sorted) {
    if (lower.includes(`@${l.name.toLowerCase()}`)) return l.slug;
  }
  return null;
}

// Replace every "@LocName" (case-insensitive) with "📍 LocName" using
// the canonical capitalization. Used for push notification bodies and
// any other text-only renderings where we can't render a styled inline
// pill.
export function expandLocationTags(
  text: string,
  locations: Location[]
): string {
  let out = text;
  const sorted = [...locations].sort(
    (a, b) => b.name.length - a.name.length
  );
  for (const l of sorted) {
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

export type Fix = { latitude: number; longitude: number; accuracy: number };

// Capture the best GPS fix the browser can give us before the deadline.
// Uses watchPosition (not getCurrentPosition) so we get *successive*
// improving fixes — the first callback is often the cached Wi-Fi/IP
// triangulation (~1-5km radius); the GPS chip then narrows it down.
// Resolves early once we beat `minAccuracyM`.
export async function getBestPosition(
  timeoutMs = 8000,
  minAccuracyM = 50
): Promise<Fix | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    let best: Fix | null = null;
    let done = false;
    let watchId: number | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (watchId !== null) {
        try {
          navigator.geolocation.clearWatch(watchId);
        } catch {
          /* already cleared */
        }
      }
      resolve(best);
    };
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const fix: Fix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        if (!best || fix.accuracy < best.accuracy) best = fix;
        if (fix.accuracy <= minAccuracyM) finish();
      },
      () => finish(),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
    setTimeout(finish, timeoutMs);
  });
}

// Background-warm the browser's geolocation hardware so the next
// getBestPosition() call has the GPS chip already powered on. We don't
// rely on the result here — startGeoWatch is what actually populates
// the cache.
export function primeGeolocation(): void {
  if (typeof navigator === "undefined" || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    () => {},
    () => {},
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
  );
}

const LAST_POS_KEY = "church-alert:lastPos";
type StoredPos = {
  latitude: number;
  longitude: number;
  accuracy: number;
  ts: number;
};

// Cap the fallback at this age — better to send no coords than coords from
// before the user moved across town.
const STALE_AFTER_MS = 10 * 60 * 1000;
// Don't cache a fix worse than this — keeps Wi-Fi triangulation garbage
// (~1-5km radius) out of the localStorage fallback.
const CACHE_MAX_ACCURACY_M = 200;

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
// fresh *high-accuracy* fix to localStorage. We refuse to overwrite a
// good cached fix with a worse one, so a temporary Wi-Fi-only fallback
// can't poison the cache. Optional `onFix` fires for *every* update
// (including poor ones) so the UI can show real-time accuracy state.
export function startGeoWatch(onFix?: (fix: Fix) => void): () => void {
  if (typeof navigator === "undefined" || !navigator.geolocation) return () => {};
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const fix: Fix = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      if (onFix) onFix(fix);
      if (fix.accuracy > CACHE_MAX_ACCURACY_M) return;
      const prev = readLastKnownPos();
      // Only overwrite a recent cached fix if the new one is at least as
      // accurate. Stale prev gets replaced regardless.
      const prevIsFresh = prev && Date.now() - prev.ts < 60_000;
      if (prevIsFresh && prev.accuracy < fix.accuracy) return;
      writeLastKnownPos({ ...fix, ts: Date.now() });
    },
    () => {
      /* permission errors handled elsewhere via permissions API */
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 }
  );
  return () => {
    try {
      navigator.geolocation.clearWatch(id);
    } catch {
      /* already cleared */
    }
  };
}

// Best-effort coords for a panic: try for a fresh sub-50m GPS fix, then
// fall back to whatever the live watch cached. We *prefer* the cached
// fix when the live one is dramatically less accurate (e.g. live just
// returned Wi-Fi triangulation with a 2km radius while the watch had
// captured a real 30m GPS lock minutes ago).
export async function bestPanicCoords(): Promise<Fix | null> {
  const live = await getBestPosition(7000, 50);
  const cached = readLastKnownPos();
  const cachedFix: Fix | null = cached
    ? { latitude: cached.latitude, longitude: cached.longitude, accuracy: cached.accuracy }
    : null;
  if (live && (!cachedFix || live.accuracy <= cachedFix.accuracy)) return live;
  return cachedFix ?? live;
}

// Extract a human-readable message from anything `throw`n. Handles native
// Error, Supabase PostgrestError / AuthError plain objects, and falls back
// to a stringified form. Always logs the raw error to console so DevTools
// captures shapes we can't yet handle, and refuses to ever return the
// useless literal "[object Object]".
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error";
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message.length > 0)
      return obj.message;
    if (typeof obj.error_description === "string")
      return obj.error_description;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.msg === "string") return obj.msg;
    if (typeof obj.statusText === "string") return obj.statusText;
    if (typeof obj.code === "string") return `Error code: ${obj.code}`;
    try {
      const json = JSON.stringify(obj, Object.getOwnPropertyNames(obj));
      if (json && json !== "{}") return json;
    } catch {
      /* unstringifiable — fall through */
    }
    if (typeof console !== "undefined") {
      console.error("[errorMessage] unrecognized error object:", err);
    }
    return "Something went wrong (see browser console for details)";
  }
  if (err == null) return "Unknown error";
  const s = String(err);
  return s === "[object Object]"
    ? "Something went wrong (see browser console for details)"
    : s;
}

export function alertTone(message: string): "panic" | "standdown" | "beep" {
  if (/^PANIC\b/i.test(message)) return "panic";
  if (/^STAND DOWN\b/i.test(message)) return "standdown";
  return "beep";
}

export function teamName(slug: TeamSlug | string, teams: Team[]): string {
  const t = teams.find((x) => x.slug === slug);
  return t ? t.name : slug;
}

export function parseOptionalCoordinate(
  value: string,
  kind: "latitude" | "longitude"
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error("Latitude and longitude must be numbers.");
  }
  return validateCoordinateValue(parsed, kind);
}

export function validateCoordinateValue(
  value: number | null | undefined,
  kind: "latitude" | "longitude"
): number | null {
  if (value == null) return null;
  const max = kind === "latitude" ? 90 : 180;
  if (!Number.isFinite(value) || value < -max || value > max) {
    throw new Error(
      kind === "latitude"
        ? "Latitude must be between -90 and 90."
        : "Longitude must be between -180 and 180."
    );
  }
  return value;
}

// Pick the closest known location to (lat, lng), but only if it's within
// `maxMeters` (default 500m). Skips locations without coords. Returns null
// when the sender is too far from any known location — that prevents an
// alert from auto-tagging a far-away church location just because it
// happens to be the least-far one.
export function nearestLocationTo(
  lat: number,
  lng: number,
  locations: Location[],
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
