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
  detectLocationInText,
  formatTimestamp,
  getQuickPosition,
  primeGeolocation,
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

type Church = { id: string; name: string };
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; church: Church; displayName: string; userId: string }
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
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPush(pushSupportInitial());
    registerServiceWorker();
    primeGeolocation();
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
            .maybeSingle<{ role: string }>(),
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
      setState({ kind: "ready", church, displayName, userId: userData.user.id });
    })();

    return () => {
      cancelled = true;
    };
  }, [churchId, router]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const channel = supabase
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
              if (tone === "panic") play(sirenUrl());
              else if (tone === "standdown") play(allClearUrl());
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
      supabase.removeChannel(channel);
    };
  }, [state.kind, churchId]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [messages.length]);

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (state.kind !== "ready") return;
      const text = draft.trim();
      if (!text) return;
      setSending(true);
      try {
        const teamSlug: TeamSlug | null =
          channel === "everyone" ? null : channel;
        const location = detectLocationInText(text);
        const { error } = await supabase.from("alerts").insert({
          church_id: churchId,
          message: text,
          sender_name: state.displayName,
          sender_id: state.userId,
          is_alert: false,
          team_slug: teamSlug,
          location,
        });
        if (error) throw error;
        setDraft("");
      } finally {
        setSending(false);
      }
    },
    [draft, churchId, state, channel]
  );

  const handlePanic = useCallback(
    async (kind: "panic" | "standdown") => {
      if (state.kind !== "ready") return;
      const message =
        kind === "panic"
          ? "PANIC — emergency help needed"
          : "STAND DOWN — false alarm, all clear";
      if (
        !window.confirm(
          kind === "panic"
            ? "Send PANIC alert to everyone in this church?"
            : "Send STAND DOWN to clear the alert?"
        )
      )
        return;
      setPanicSending(true);
      try {
        const coords =
          kind === "panic" ? await getQuickPosition(5000, 5 * 60_000) : null;
        const { data: inserted, error } = await supabase
          .from("alerts")
          .insert({
            church_id: churchId,
            message,
            sender_name: state.displayName,
            sender_id: state.userId,
            is_alert: true,
            latitude: coords?.latitude ?? null,
            longitude: coords?.longitude ?? null,
          })
          .select(
            "id, church_id, message, sender_name, sender_id, is_alert, latitude, longitude, team_slug, location, created_at"
          )
          .single();
        if (error) {
          window.alert(`Could not send: ${error.message}`);
          return;
        }
        if (inserted) fanoutPush(inserted as Record<string, unknown>);
      } finally {
        setPanicSending(false);
      }
    },
    [churchId, state]
  );

  if (state.kind === "loading") {
    return (
      <main className="flex min-h-full items-center justify-center text-sm text-gray-500">
        Loading…
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-3 px-6 py-12">
        <h1 className="text-xl font-semibold">Can&apos;t open chat</h1>
        <p className="text-sm text-red-600">{state.message}</p>
        <Link className="text-sm text-red-600 underline" href="/home">
          Back to home
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col">
      <header className="flex items-baseline justify-between border-b border-gray-200 px-4 py-3">
        <Link href="/home" className="text-sm text-gray-500 underline">
          ← Home
        </Link>
        <h1 className="text-base font-semibold">{state.church.name}</h1>
        <span className="text-xs text-gray-400">{state.displayName}</span>
      </header>

      <div className="flex gap-2 border-b border-gray-200 px-4 py-3">
        <button
          type="button"
          onClick={() => handlePanic("panic")}
          disabled={panicSending}
          className="flex-1 rounded bg-red-700 px-4 py-3 text-base font-bold uppercase tracking-wide text-white shadow-sm disabled:opacity-50"
        >
          🚨 Panic
        </button>
        <button
          type="button"
          onClick={() => handlePanic("standdown")}
          disabled={panicSending}
          className="rounded border border-gray-300 px-3 py-3 text-sm font-medium text-gray-700 disabled:opacity-50"
        >
          Stand down
        </button>
      </div>

      {push === "default" && (
        <button
          type="button"
          onClick={async () => {
            const next = await enableNotifications({
              churchId,
              userId: state.userId,
              senderName: state.displayName,
            });
            setPush(next);
          }}
          className="border-b border-gray-200 px-4 py-2 text-left text-sm text-red-700 underline"
        >
          🔔 Enable push notifications for this church
        </button>
      )}
      {push === "denied" && (
        <p className="border-b border-gray-200 px-4 py-2 text-xs text-gray-500">
          Notifications blocked. You&apos;ll still hear the in-app siren.
        </p>
      )}

      <nav className="flex gap-2 overflow-x-auto border-b border-gray-200 px-4 py-2">
        <ChannelChip
          active={channel === "everyone"}
          onClick={() => setChannel("everyone")}
          label="Everyone"
        />
        {TEAMS.map((t) => (
          <ChannelChip
            key={t.slug}
            active={channel === t.slug}
            onClick={() => setChannel(t.slug)}
            label={t.name}
          />
        ))}
      </nav>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-3">
        {(() => {
          // Panic/standdown alerts always show across every channel so a
          // member who happens to be on a team tab doesn't miss an
          // emergency. Plain chat messages stick to their channel.
          const visible = messages.filter((m) =>
            m.is_alert
              ? true
              : channel === "everyone"
                ? m.team_slug === null
                : m.team_slug === channel
          );
          if (visible.length === 0) {
            return (
              <p className="py-8 text-center text-sm text-gray-400">
                No messages here yet. Say something.
              </p>
            );
          }
          return (
            <ul className="flex flex-col gap-2">
              {visible.map((m) => {
                const tone = m.is_alert ? alertTone(m.message) : null;
                const alertClass =
                  tone === "panic"
                    ? "rounded border border-red-300 bg-red-50 p-2"
                    : tone === "standdown"
                      ? "rounded border border-emerald-300 bg-emerald-50 p-2"
                      : "";
                const teamLabel =
                  m.team_slug && isTeamSlug(m.team_slug)
                    ? TEAMS.find((t) => t.slug === m.team_slug)?.name
                    : null;
                const locationLabel = m.location
                  ? LOCATIONS.find((l) => l.slug === m.location)?.name
                  : null;
                return (
                  <li key={m.id} className={`flex flex-col ${alertClass}`}>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium">
                        {m.sender_name}
                      </span>
                      {teamLabel && (
                        <span className="text-xs text-gray-500">
                          · {teamLabel}
                        </span>
                      )}
                      {locationLabel && (
                        <span className="text-xs text-gray-500">
                          · 📍 {locationLabel}
                        </span>
                      )}
                      <span className="text-xs text-gray-400">
                        {formatTimestamp(m.created_at)}
                      </span>
                    </div>
                    <p
                      className={
                        tone === "panic"
                          ? "text-sm font-semibold text-red-800"
                          : tone === "standdown"
                            ? "text-sm font-semibold text-emerald-800"
                            : "text-sm"
                      }
                    >
                      {m.message}
                    </p>
                    {m.latitude != null && m.longitude != null && (
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${m.latitude},${m.longitude}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 self-start text-xs text-red-700 underline"
                      >
                        📍 View on map
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          );
        })()}
      </div>

      <form
        onSubmit={handleSend}
        className="flex gap-2 border-t border-gray-200 px-4 py-3"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message #${
            channel === "everyone"
              ? "everyone"
              : TEAMS.find((t) => t.slug === channel)?.name ?? channel
          }… (try @${LOCATIONS[0].name})`}
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-base"
          autoFocus
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </main>
  );
}

function ChannelChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
        active
          ? "border-red-600 bg-red-600 text-white"
          : "border-gray-300 text-gray-700"
      }`}
    >
      {label}
    </button>
  );
}
