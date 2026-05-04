import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import { expandLocationTags, teamName } from "@/lib/utils";
import type { Location, Team } from "@/lib/supabase";

export const runtime = "nodejs";

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
// Service role key bypasses RLS — required to read every push_subscription
// for the church when fanning out a notification.
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (VAPID_PUBLIC && VAPID_PRIVATE && VAPID_SUBJECT) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

type AlertRow = {
  id: string;
  church_id: string;
  team_slug: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  message: string;
  sender_name: string;
  sender_id: string | null;
  is_alert: boolean;
  created_at: string;
};

// Supabase DB Webhook POSTs this shape on INSERT:
// { type: "INSERT", table: "alerts", schema: "public", record: {...}, old_record: null }
type WebhookBody = {
  type: string;
  table: string;
  record: AlertRow;
};

export async function POST(request: Request) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !VAPID_SUBJECT) {
    return Response.json({ error: "vapid not configured" }, { status: 500 });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return Response.json({ error: "supabase not configured" }, { status: 500 });
  }

  const body = (await request.json()) as WebhookBody;
  if (body.table !== "alerts" || body.type !== "INSERT" || !body.record) {
    return Response.json({ skipped: "not an alert insert" });
  }

  const alert = body.record;
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Pull the church's team and location names so we can render a friendly
  // notification title/body. These are per-church configurable now so we
  // can't read them from a hardcoded constant.
  const [{ data: teams }, { data: locations }] = await Promise.all([
    supabase
      .from("church_teams")
      .select("slug, name, sort_order")
      .eq("church_id", alert.church_id)
      .returns<Team[]>(),
    supabase
      .from("church_locations")
      .select("slug, name, latitude, longitude, sort_order")
      .eq("church_id", alert.church_id)
      .returns<Location[]>(),
  ]);

  // Find subscriptions to notify: same church, excluding sender by user_id
  // (more robust than name), filtered by team membership.
  let query = supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth, sender_name, joined_teams, user_id")
    .eq("church_id", alert.church_id);
  if (alert.sender_id) {
    query = query.neq("user_id", alert.sender_id);
  } else {
    query = query.neq("sender_name", alert.sender_name);
  }

  if (alert.team_slug) {
    query = query.contains("joined_teams", [alert.team_slug]);
  }
  // Church-wide alerts (team_slug null) go to everyone in the church.

  const { data: subs, error: subsErr } = await query;
  if (subsErr) {
    return Response.json({ error: subsErr.message }, { status: 500 });
  }
  if (!subs || subs.length === 0) {
    return Response.json({ sent: 0, reason: "no subscribers" });
  }

  const isPanic = alert.team_slug === null && alert.is_alert;
  const channel = alert.team_slug
    ? teamName(alert.team_slug, teams ?? [])
    : "Everyone";
  const titlePrefix = alert.is_alert ? "🚨" : "💬";
  const title = `${titlePrefix} ${alert.sender_name} · ${channel}`;
  const pushBody = buildNotifBody(alert, locations ?? []);
  const tagPrefix = alert.is_alert ? "alert" : "chat";

  const payload = JSON.stringify({
    title,
    body: pushBody,
    tag: `${tagPrefix}-${alert.id}`,
    isPanic,
    url: "/",
  });

  const deadEndpoints: string[] = [];
  const results = await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          payload
        );
        return "sent";
      } catch (err) {
        const sc = (err as { statusCode?: number }).statusCode;
        if (sc === 404 || sc === 410) deadEndpoints.push(s.endpoint);
        throw err;
      }
    })
  );

  if (deadEndpoints.length > 0) {
    await supabase
      .from("push_subscriptions")
      .delete()
      .in("endpoint", deadEndpoints);
  }

  const sent = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - sent;
  return Response.json({ sent, failed, pruned: deadEndpoints.length });
}

function buildNotifBody(alert: AlertRow, locations: Location[]): string {
  let text = expandLocationTags(alert.message, locations);
  if (alert.latitude != null && alert.longitude != null) {
    text += ` · GPS attached`;
  }
  return text;
}
