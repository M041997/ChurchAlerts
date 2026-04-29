"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { formatTimestamp } from "@/lib/utils";

type Message = {
  id: string;
  church_id: string;
  message: string;
  sender_name: string;
  is_alert: boolean;
  created_at: string;
};

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
  const scrollerRef = useRef<HTMLDivElement | null>(null);

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
        .select("id, church_id, message, sender_name, is_alert, created_at")
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
          setMessages((prev) =>
            prev.some((m) => m.id === row.id) ? prev : [row, ...prev]
          );
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
        const { error } = await supabase.from("alerts").insert({
          church_id: churchId,
          message: text,
          sender_name: state.displayName,
          sender_id: state.userId,
          is_alert: false,
        });
        if (error) throw error;
        setDraft("");
      } finally {
        setSending(false);
      }
    },
    [draft, churchId, state]
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

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">
            No messages yet. Say something.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((m) => (
              <li key={m.id} className="flex flex-col">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{m.sender_name}</span>
                  <span className="text-xs text-gray-400">
                    {formatTimestamp(m.created_at)}
                  </span>
                </div>
                <p className="text-sm">{m.message}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        onSubmit={handleSend}
        className="flex gap-2 border-t border-gray-200 px-4 py-3"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message…"
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
