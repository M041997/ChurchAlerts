import { supabase } from "@/lib/supabase";

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushSupport =
  | "unsupported"
  | "default"
  | "granted"
  | "denied";

export function pushSupportInitial(): PushSupport {
  if (typeof window === "undefined") return "default";
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    return "unsupported";
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission as PushSupport;
}

export async function registerServiceWorker(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    console.warn("service worker register failed:", err);
  }
}

// Ask the browser for notification permission and, if granted, subscribe
// to push and persist the endpoint linked to the current auth user.
export async function enableNotifications(args: {
  churchId: string;
  userId: string;
  senderName: string;
  joinedTeams: string[];
}): Promise<PushSupport> {
  if (typeof window === "undefined") return "default";
  if (!("Notification" in window)) return "unsupported";
  if (!VAPID_PUBLIC) return "unsupported";

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm as PushSupport;

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
      });
    }
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return "granted";
    await supabase.from("push_subscriptions").upsert(
      {
        church_id: args.churchId,
        user_id: args.userId,
        sender_name: args.senderName,
        joined_teams: args.joinedTeams,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" }
    );
  } catch (err) {
    console.warn("push subscribe failed:", err);
  }
  return "granted";
}

export async function syncPushTeams(args: {
  churchId: string;
  userId: string;
  joinedTeams: string[];
}): Promise<void> {
  const { error } = await supabase
    .from("push_subscriptions")
    .update({
      joined_teams: args.joinedTeams,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", args.userId)
    .eq("church_id", args.churchId);
  if (error) throw error;
}

// Read the alerts_only preference for this user in this church.
// Returns false (i.e. push every chat message) when no row exists yet.
export async function readAlertsOnly(args: {
  churchId: string;
  userId: string;
}): Promise<boolean> {
  const { data } = await supabase
    .from("push_subscriptions")
    .select("alerts_only")
    .eq("user_id", args.userId)
    .eq("church_id", args.churchId)
    .limit(1)
    .maybeSingle<{ alerts_only: boolean }>();
  return data?.alerts_only ?? false;
}

// Persist the alerts_only flag for every subscription this user has
// against this church (typically one per device).
export async function setAlertsOnly(args: {
  churchId: string;
  userId: string;
  alertsOnly: boolean;
}): Promise<void> {
  const { error } = await supabase
    .from("push_subscriptions")
    .update({
      alerts_only: args.alertsOnly,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", args.userId)
    .eq("church_id", args.churchId);
  if (error) throw error;
}

// Fire-and-forget: tell the server to fan a freshly-inserted alert out
// to push subscribers. In production this happens automatically via a
// Supabase database webhook; this client trigger keeps local dev usable
// without configuring the webhook.
export function fanoutPush(record: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  fetch("/api/push-notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "INSERT", table: "alerts", record }),
  }).catch(() => {});
}
