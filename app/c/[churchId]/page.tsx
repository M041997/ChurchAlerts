"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  supabase,
  TEAMS,
  LOCATIONS,
  isTeamSlug,
  type TeamSlug,
  type LocationSlug,
} from "@/lib/supabase";
import {
  alertTone,
  bestPanicCoords,
  detectLocationInText,
  formatTimestamp,
  primeGeolocation,
  startGeoWatch,
} from "@/lib/utils";
import { allClearUrl, chatPingUrl, play, sirenUrl } from "@/lib/audio";
import {
  enableNotifications,
  fanoutPush,
  pushSupportInitial,
  registerServiceWorker,
  type PushSupport,
} from "@/lib/push";

type Message = {
  id: string;
  church_id: string;
  message: string;
  sender_name: string;
  sender_id: string | null;
  is_alert: boolean;
  team_slug: TeamSlug | null;
  location: LocationSlug | null;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
};

type Channel = "everyone" | TeamSlug;
type Role = "owner" | "member";
type Church = { id: string; name: string };
type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      church: Church;
      displayName: string;
      userId: string;
      role: Role;
    }
  | { kind: "error"; message: string };

export default function ChurchChatPage() {
  const router = useRouter();
  const params = useParams<{ churchId: string }>();
  const churchId = params?.churchId ?? "";
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [panicSending, setPanicSending] = useState(false);
  const [push, setPush] = useState<PushSupport>("default");
  const [channel, setChannel] = useState<Channel>("everyone");
  const [profileOpen, setProfileOpen] = useState(false);
  const [mintedInvite, setMintedInvite] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [gpsBlocked, setGpsBlocked] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPush(pushSupportInitial());
    registerServiceWorker();
    primeGeolocation();
    const stopWatch = startGeoWatch();
    if (typeof navigator !== "undefined" && navigator.permissions) {
      navigator.permissions
        .query({ name: "geolocation" as PermissionName })
        .then((p) => setGpsBlocked(p.state === "denied"))
        .catch(() => {});
    }
    return () => {
      stopWatch();
    };
  }, []);

  useEffect(() => {
    if (!churchId) return;
    let cancelled = false;

    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!userData.user) {
        router.replace("/login");
        return;
      }

      const [{ data: profile }, { data: membership }, { data: church }] =
        await Promise.all([
          supabase
            .from("profiles")
            .select("display_name")
            .eq("id", userData.user.id)
            .maybeSingle<{ display_name: string }>(),
          supabase
            .from("church_members")
            .select("role")
            .eq("user_id", userData.user.id)
            .eq("church_id", churchId)
            .maybeSingle<{ role: Role }>(),
          supabase
            .from("churches")
            .select("id, name")
            .eq("id", churchId)
            .maybeSingle<Church>(),
        ]);
      if (cancelled) return;

      if (!church) {
        setState({ kind: "error", message: "Church not found" });
        return;
      }
      if (!membership) {
        setState({ kind: "error", message: "You're not a member of this church" });
        return;
      }
      const displayName = profile?.display_name ?? userData.user.email ?? "User";

      const { data: existing } = await supabase
        .from("alerts")
        .select(
          "id, church_id, message, sender_name, sender_id, is_alert, team_slug, location, latitude, longitude, created_at"
        )
        .eq("church_id", churchId)
        .order("created_at", { ascending: false })
        .limit(200)
        .returns<Message[]>();
      if (cancelled) return;

      setMessages(existing ?? []);
      setState({
        kind: "ready",
        church,
        displayName,
        userId: userData.user.id,
        role: membership.role,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [churchId, router]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const ch = supabase
      .channel(`chat:${churchId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "alerts",
          filter: `church_id=eq.${churchId}`,
        },
        (payload) => {
          const row = payload.new as Message;
          setMessages((prev) => {
            if (prev.some((m) => m.id === row.id)) return prev;
            const ownMessage =
              state.kind === "ready" && row.sender_id === state.userId;
            if (row.is_alert) {
              const tone = alertTone(row.message);
              if (tone === "standdown") play(allClearUrl());
              else play(sirenUrl());
            } else if (!ownMessage) {
              play(chatPingUrl());
            }
            return [row, ...prev];
          });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [state.kind, churchId]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [messages.length]);

  const insertMessage = useCallback(
    async (opts: {
      message: string;
      isAlert: boolean;
      teamSlug: TeamSlug | null;
      attachGps: boolean;
    }): Promise<boolean> => {
      if (state.kind !== "ready") return false;
      const coords = opts.attachGps ? await bestPanicCoords() : null;
      const location = detectLocationInText(opts.message);
      const { data: inserted, error } = await supabase
        .from("alerts")
        .insert({
          church_id: churchId,
          message: opts.message,
          sender_name: state.displayName,
          sender_id: state.userId,
          is_alert: opts.isAlert,
          team_slug: opts.teamSlug,
          location,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
        })
        .select(
          "id, church_id, message, sender_name, sender_id, is_alert, team_slug, location, latitude, longitude, created_at"
        )
        .single();
      if (error) {
        window.alert(`Could not send: ${error.message}`);
        return false;
      }
      if (inserted && opts.isAlert) {
        fanoutPush(inserted as Record<string, unknown>);
      }
      if (opts.attachGps && !coords) {
        setGpsBlocked(true);
      }
      return true;
    },
    [churchId, state]
  );

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = draft.trim();
      if (!text) return;
      setSending(true);
      try {
        const teamSlug: TeamSlug | null =
          channel === "everyone" ? null : channel;
        const ok = await insertMessage({
          message: text,
          isAlert: false,
          teamSlug,
          attachGps: false,
        });
        if (ok) setDraft("");
      } finally {
        setSending(false);
      }
    },
    [draft, channel, insertMessage]
  );

  const handleAlertTeam = useCallback(async () => {
    const text = draft.trim();
    if (!text) {
      window.alert("Type a message to alert the team about.");
      return;
    }
    if (channel === "everyone") {
      if (
        !window.confirm(
          "Alert everyone in this church? For team-only alerts, switch to a team tab first."
        )
      )
        return;
    } else {
      const teamName = TEAMS.find((t) => t.slug === channel)?.name ?? channel;
      if (!window.confirm(`Send team alert to ${teamName}?`)) return;
    }
    setPanicSending(true);
    try {
      const teamSlug: TeamSlug | null =
        channel === "everyone" ? null : channel;
      const ok = await insertMessage({
        message: text,
        isAlert: true,
        teamSlug,
        attachGps: true,
      });
      if (ok) setDraft("");
    } finally {
      setPanicSending(false);
    }
  }, [draft, channel, insertMessage]);

  const handlePanic = useCallback(async () => {
    if (
      !window.confirm("Send PANIC alert to everyone in this church?")
    )
      return;
    setPanicSending(true);
    try {
      await insertMessage({
        message: "PANIC — emergency help needed",
        isAlert: true,
        teamSlug: null,
        attachGps: true,
      });
    } finally {
      setPanicSending(false);
    }
  }, [insertMessage]);

  const handleStandDown = useCallback(async () => {
    if (!window.confirm("Send STAND DOWN to clear the alert?")) return;
    setPanicSending(true);
    try {
      await insertMessage({
        message: "STAND DOWN — false alarm, all clear",
        isAlert: true,
        teamSlug: null,
        attachGps: false,
      });
    } finally {
      setPanicSending(false);
    }
  }, [insertMessage]);

  const handleMintInvite = useCallback(async () => {
    setMintedInvite(null);
    setInviteCopied(false);
    const { data: token, error } = await supabase.rpc("create_invite", {
      p_church_id: churchId,
    });
    if (error || !token) {
      window.alert(`Couldn't mint invite: ${error?.message ?? "unknown"}`);
      return;
    }
    setMintedInvite(`${window.location.origin}/join/${token}`);
  }, [churchId]);

  const handleCopyInvite = useCallback(async () => {
    if (!mintedInvite) return;
    try {
      await navigator.clipboard.writeText(mintedInvite);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      // fallthrough — leave the URL visible for manual copy
    }
  }, [mintedInvite]);

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  }, [router]);

  if (state.kind === "loading") {
    return (
      <main className="flex min-h-full items-center justify-center bg-neutral-950 text-sm text-neutral-400">
        Loading…
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-3 bg-neutral-950 px-6 py-12 text-neutral-100">
        <h1 className="text-xl font-semibold">Can&apos;t open chat</h1>
        <p className="text-sm text-red-400">{state.message}</p>
        <Link className="text-sm text-red-400 underline" href="/home">
          Back to home
        </Link>
      </main>
    );
  }

  const channelLabel =
    channel === "everyone"
      ? "Everyone"
      : TEAMS.find((t) => t.slug === channel)?.name ?? channel;
  const visible = messages.filter((m) =>
    m.is_alert
      ? true
      : channel === "everyone"
        ? m.team_slug === null
        : m.team_slug === channel
  );

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/95 px-4 py-3 backdrop-blur">
        <h1 className="text-base font-semibold">Church Alert</h1>
      </header>

      <button
        type="button"
        onClick={handlePanic}
        disabled={panicSending}
        className="mx-3 mt-3 rounded bg-red-700 px-4 py-3 text-base font-bold tracking-wide text-white shadow-md disabled:opacity-50"
      >
        🚨 PANIC — CHURCH-WIDE ALERT
      </button>

      <div className="relative mx-3 mt-3 rounded border border-neutral-800 bg-neutral-900 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-sm">
            <span className="text-neutral-400">{state.church.name}</span>
            <span className="mx-1 text-neutral-600">·</span>
            <span className="font-medium">{state.displayName}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                if (push !== "default") return;
                const next = await enableNotifications({
                  churchId,
                  userId: state.userId,
                  senderName: state.displayName,
                });
                setPush(next);
              }}
              title={
                push === "granted"
                  ? "Notifications on"
                  : push === "denied"
                    ? "Notifications blocked"
                    : push === "unsupported"
                      ? "Notifications unavailable"
                      : "Enable notifications"
              }
              disabled={push !== "default"}
              className={`rounded border px-2 py-1 text-xs ${
                push === "granted"
                  ? "border-emerald-500/50 text-emerald-300"
                  : push === "denied"
                    ? "border-red-500/50 text-red-300"
                    : "border-neutral-700 text-neutral-300"
              }`}
            >
              {push === "granted" ? "🔔" : push === "denied" ? "🔕" : "🔔"}
            </button>
            <button
              type="button"
              onClick={() => setProfileOpen((v) => !v)}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-200"
            >
              Profile
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300"
            >
              Sign out
            </button>
          </div>
        </div>

        {profileOpen && (
          <div className="mt-3 flex flex-col gap-2 border-t border-neutral-800 pt-3 text-sm">
            <div className="text-xs uppercase text-neutral-500">
              {state.role}
            </div>
            <Link
              href="/home"
              className="text-sm text-red-400 underline"
            >
              ← Back to home
            </Link>
            {state.role === "owner" && (
              <>
                <button
                  type="button"
                  onClick={handleMintInvite}
                  className="self-start rounded bg-red-700 px-3 py-1 text-sm font-medium text-white"
                >
                  Mint invite link
                </button>
                {mintedInvite && (
                  <div className="flex flex-col gap-1 rounded bg-neutral-800 p-2 text-xs">
                    <span className="text-neutral-400">
                      Single-use link (share with one person):
                    </span>
                    <code className="break-all text-neutral-100">
                      {mintedInvite}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyInvite}
                      className="self-start rounded border border-neutral-700 px-2 py-0.5 text-xs"
                    >
                      {inviteCopied ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {gpsBlocked && (
        <div className="mx-3 mt-3 rounded border border-amber-700/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
          <p className="font-semibold">📍 Location is blocked</p>
          <p className="mt-1 text-xs text-amber-200/80">
            Your alerts won&apos;t include your location. To fix on iPhone:
          </p>
          <ol className="mt-2 list-inside list-decimal space-y-0.5 text-xs text-amber-200/80">
            <li>Settings → Privacy &amp; Security → Location Services → ON</li>
            <li>Same screen → Safari Websites → &ldquo;While Using the App&rdquo;</li>
            <li>
              In Safari: tap &ldquo;AA&rdquo; in the URL bar → Website Settings
              → Location → Allow
            </li>
            <li>Close and reopen this page, then try again</li>
          </ol>
          <button
            type="button"
            onClick={() => {
              setGpsBlocked(false);
              primeGeolocation();
            }}
            className="mt-3 rounded border border-amber-700/60 px-3 py-1 text-xs"
          >
            Try again
          </button>
        </div>
      )}

      <form
        onSubmit={handleSend}
        className="mx-3 mt-3 flex flex-col gap-2 rounded border border-neutral-800 bg-neutral-900 p-3"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${channelLabel}… (type @ to tag a location)`}
          rows={2}
          className="resize-none bg-transparent text-base text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
        />
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="flex-1 rounded bg-neutral-800 px-3 py-2 text-sm font-medium text-neutral-100 disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            onClick={handleAlertTeam}
            disabled={panicSending || !draft.trim()}
            className="flex-1 rounded bg-red-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            {panicSending ? "Sending…" : "Alert team"}
          </button>
        </div>
      </form>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-3 py-3 pb-24">
        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-neutral-500">
            No messages here yet. Say something.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {visible.map((m) => {
              const tone = m.is_alert ? alertTone(m.message) : null;
              const cardClass = tone
                ? tone === "panic"
                  ? "rounded border border-red-700/60 bg-red-950/40 p-3"
                  : "rounded border border-emerald-700/50 bg-emerald-950/30 p-3"
                : "rounded border border-neutral-800 bg-neutral-900 p-3";
              const teamLabel =
                m.team_slug && isTeamSlug(m.team_slug)
                  ? TEAMS.find((t) => t.slug === m.team_slug)?.name
                  : null;
              const locationLabel = m.location
                ? LOCATIONS.find((l) => l.slug === m.location)?.name
                : null;
              return (
                <li key={m.id} className={`flex flex-col ${cardClass}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium text-neutral-100">
                      {tone === "panic" ? "🚨 " : ""}
                      {m.sender_name}
                    </span>
                    {m.is_alert && (
                      <span className="rounded bg-red-700/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
                        {teamLabel ?? "Everyone"}
                      </span>
                    )}
                    {!m.is_alert && teamLabel && (
                      <span className="text-xs text-neutral-500">
                        · {teamLabel}
                      </span>
                    )}
                    {locationLabel && (
                      <span className="text-xs text-neutral-400">
                        · 📍 {locationLabel}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-neutral-500">
                      {formatTimestamp(m.created_at)}
                    </span>
                  </div>
                  <p
                    className={`mt-1 whitespace-pre-wrap text-sm ${
                      tone === "panic"
                        ? "font-semibold text-red-200"
                        : tone === "standdown"
                          ? "font-semibold text-emerald-200"
                          : "text-neutral-200"
                    }`}
                  >
                    {m.message}
                  </p>
                  {m.latitude != null && m.longitude != null && (
                    <div className="mt-2 flex flex-col gap-1">
                      <iframe
                        title="Alert location"
                        loading="lazy"
                        src={`https://www.google.com/maps?q=${m.latitude},${m.longitude}&z=16&output=embed`}
                        className="h-40 w-full rounded border border-neutral-800"
                      />
                      <div className="flex gap-3 text-xs">
                        <a
                          href={`https://www.google.com/maps/dir/?api=1&destination=${m.latitude},${m.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-red-400 underline"
                        >
                          Directions in Google Maps ↗
                        </a>
                        <a
                          href={`https://maps.apple.com/?daddr=${m.latitude},${m.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-red-400 underline"
                        >
                          Directions in Apple Maps ↗
                        </a>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {messages.some((m) => m.is_alert && alertTone(m.message) === "panic") && (
          <button
            type="button"
            onClick={handleStandDown}
            disabled={panicSending}
            className="mt-4 w-full rounded border border-emerald-700/60 px-4 py-2 text-sm font-medium text-emerald-300 disabled:opacity-50"
          >
            Send Stand Down
          </button>
        )}
      </div>

      <nav className="sticky bottom-0 flex border-t border-neutral-800 bg-neutral-950/95 backdrop-blur">
        <BottomTab
          active={channel !== "everyone" && channel === firstTeam(channel)}
          label={
            channel !== "everyone"
              ? TEAMS.find((t) => t.slug === channel)?.name ?? "Team"
              : "Worship"
          }
          onClick={() => setChannel(channel === "everyone" ? "worship" : channel)}
          highlight
        />
        <BottomTab
          active={false}
          label="Other teams"
          onClick={() => {
            const idx = TEAMS.findIndex((t) => t.slug === channel);
            const next =
              idx === -1 ? TEAMS[1].slug : TEAMS[(idx + 1) % TEAMS.length].slug;
            setChannel(next);
          }}
        />
        <BottomTab
          active={channel === "everyone"}
          label="Everyone"
          onClick={() => setChannel("everyone")}
        />
      </nav>
    </main>
  );
}

function firstTeam(c: Channel): TeamSlug {
  return c === "everyone" ? TEAMS[0].slug : c;
}

function BottomTab({
  active,
  label,
  onClick,
  highlight,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-4 py-3 text-center text-sm ${
        active
          ? highlight
            ? "font-semibold text-emerald-400"
            : "font-semibold text-neutral-100"
          : "text-neutral-500"
      }`}
    >
      {label}
    </button>
  );
}
