# Church Alert

Live safety + chat PWA for church staff. Each church is an isolated group; members can chat per-team or church-wide, fire a panic alert with GPS, and receive web push notifications even when the app is closed.

> **Heads-up for any agent reading this:** [AGENTS.md](AGENTS.md) is binding. This repo runs Next.js 16 / React 19 with breaking changes from the versions in most model training data. Check `node_modules/next/dist/docs/` before assuming an API.

## Stack

- **Next.js 16** App Router, React 19, TypeScript, Tailwind v4
- **Supabase** for auth, Postgres, Realtime, and RLS
- **web-push** + a custom service worker ([public/sw.js](public/sw.js)) for notifications
- **Vitest** for unit tests (see [lib/utils.test.ts](lib/utils.test.ts))

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
npm run lint
npx vitest run       # unit tests for lib/utils.ts
node scripts/smoketest-schema.mjs   # hits the live REST API to verify schema
```

### Env files

| File | Purpose |
| --- | --- |
| [.env](.env) | Production-style: points at the deployed Supabase project + VAPID keys |
| [.env.development.local](.env.development.local) | Local Supabase (`supabase start`); has the service-role key for the push-fanout route |

Required vars:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — client SDK
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — service worker subscribe step
- `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — server-side push signing in [app/api/push-notify/route.ts](app/api/push-notify/route.ts)
- `SUPABASE_SERVICE_ROLE_KEY` *(dev only)* — fan-out route reads every push_subscription bypassing RLS

Regenerate VAPID with `npx web-push generate-vapid-keys`.

### Supabase schema

[supabase/schema.sql](supabase/schema.sql) is the source of truth. Paste it into the Supabase SQL editor — the file is idempotent (legacy rename guards, `create … if not exists`, `on conflict do nothing`). It sets up tables, indexes, the `supabase_realtime` publication for `alerts`, RLS policies, and the RPCs (`create_church`, `create_invite`, `redeem_invite`, `promote_member`, `seed_church_defaults`).

The demo church `CHURCH1` (join code) is seeded automatically so a fresh DB has something to join.

## App layout

```
app/
  page.tsx                         # /  → redirects to /home or /login
  layout.tsx                       # PWA manifest, fonts, theme color
  login/, signup/, forgot-password/, reset-password/
  home/page.tsx                    # Church list, members panel, mint invite
  join/[token]/page.tsx            # Invite redemption
  c/[churchId]/
    page.tsx                       # The chat (~55k chars — the heart of the app)
    settings/page.tsx              # Admin: per-church teams & locations
  api/push-notify/route.ts         # Push fan-out (Supabase webhook target)
lib/
  supabase.ts                      # Client + shared types + storage keys
  utils.ts                         # GPS, timestamp fmt, location parsing, error helpers
  audio.ts                         # WAV data-URL synthesis for panic/all-clear/ping
  push.ts                          # Subscribe + alerts_only toggle + dev fan-out trigger
  utils.test.ts                    # Vitest cases for the helpers
public/
  sw.js                            # Service worker — push + notificationclick deep link
  manifest.webmanifest, icon-*.png # PWA install
supabase/schema.sql
scripts/smoketest-schema.mjs       # Anon-key REST probe of expected schema bits
```

## Data model (short version)

- **profiles** — one per auth user, auto-created by the `on_auth_user_created` trigger
- **churches** — id, name, join_code (unique). `CHURCH1` is the seeded demo
- **church_members** — `(user_id, church_id)` PK + role (`owner` | `member`) + `joined_teams text[]`
- **church_teams**, **church_locations** — per-church configurable. Slugs are stable across renames so `alerts.team_slug` / `alerts.location` keep resolving
- **alerts** — chat + emergency rows. `team_slug = null` means church-wide. `is_alert = true` means emergency (auto-rings + bypasses `alerts_only`)
- **invites** — single-use token, 7-day expiry
- **push_subscriptions** — one row per browser/device, carries `joined_teams` + `alerts_only`

### RLS in one sentence

Only members of a church can read or insert into that church's `alerts` / `church_teams` / `church_locations` / `push_subscriptions`; owners can delete alerts and manage teams/locations. Membership inserts go through `redeem_invite` (SECURITY DEFINER) so the client never bypasses checks.

## Push notification flow

1. User opens the chat → [lib/push.ts](lib/push.ts) `enableNotifications()` registers `/sw.js`, asks for permission, subscribes via `PushManager`, upserts the endpoint into `push_subscriptions`.
2. Someone inserts an `alerts` row.
3. **Production:** a Supabase Database Webhook (configured in the dashboard, not in code) POSTs the row to `/api/push-notify`.
4. **Dev:** the client also calls `fanoutPush()` after a successful insert, hitting the same route directly — keeps push working without configuring the webhook locally.
5. [app/api/push-notify/route.ts](app/api/push-notify/route.ts) loads the church's teams/locations, finds matching subscriptions (filters by team membership, excludes sender, respects `alerts_only`), and sends payloads via `web-push`. Dead 404/410 endpoints get pruned.
6. [public/sw.js](public/sw.js) shows the notification. Click → focus an existing tab on the chat URL or navigate one there (`requireInteraction: true` for panic).

## Things that bit me (read before changing)

- **Per-church teams/locations.** Don't reach for `DEFAULT_TEAMS` / `DEFAULT_LOCATIONS` from [lib/supabase.ts](lib/supabase.ts) at runtime — those are only seeds for `create_church`. The chat, push fan-out, and settings all load from `church_teams` / `church_locations`.
- **GPS captures use `watchPosition`, not `getCurrentPosition`.** The first callback is usually cached Wi-Fi triangulation (1–5km radius); the GPS chip refines it later. See `getBestPosition()` and `startGeoWatch()` in [lib/utils.ts](lib/utils.ts:71). `bestPanicCoords()` prefers the cached high-accuracy fix over a fresh-but-worse one.
- **Senders can't delete their own alerts.** The `alerts_owner_delete` policy is intentional: emergency audit trails matter more than self-redaction. Only church admins can moderate.
- **`alerts_only` does not silence emergencies.** The fan-out route only filters that flag for `is_alert = false` rows.
- **The PoC `groups` / `alerts.group_id` rename guards are still in the schema.** They're no-ops on a fresh DB; do not strip them, they protect any production DB that pre-dates the rename.
- **iOS PWA push requires "Add to Home Screen" first** — Notification API isn't available in standalone Safari otherwise.

## Memory / state keys

All `localStorage` keys are defined in [lib/supabase.ts](lib/supabase.ts) (`CHAT_MUTED_KEY`, `LAST_KNOWN_POS_KEY`, `JOINED_CHURCH_KEY`, etc.) plus `LAST_POS_KEY` in [lib/utils.ts](lib/utils.ts:122). Grep these slugs before adding new ones.

## Deploy

- **Vercel** for the Next.js app. Add the same env vars from `.env` (plus `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and a real `SUPABASE_SERVICE_ROLE_KEY`) to project settings.
- **Supabase** dashboard → Database → Webhooks → POST `alerts INSERT` to `https://<your-app>/api/push-notify`. Without this, push only works while a sender's tab is open.
