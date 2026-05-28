export const runtime = "nodejs";

// Configuration health check. Returns 200 only when every env var required
// for the production flows is present. Returns 503 with the list of missing
// keys so misconfigured deploys are loud instead of silent. Safe to expose:
// it reports presence (true/false) only, never the values themselves.
const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "PUSH_NOTIFY_SECRET",
] as const;

export async function GET() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  const ok = missing.length === 0;
  return Response.json(
    { ok, missing },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
}
