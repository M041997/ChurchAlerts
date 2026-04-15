"use client";

import { useEffect, useRef, useState } from "react";
import {
  supabase,
  hasSupabaseConfig,
  DEMO_JOIN_CODE,
  NAME_STORAGE_KEY,
  type Message,
} from "@/lib/supabase";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center bg-zinc-950 text-zinc-100">
      <header className="w-full border-b border-zinc-800 px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Church Alert</h1>
        </div>
      </header>

      <section className="mx-auto w-full max-w-2xl flex-1 px-6 py-8">
        {!hasSupabaseConfig ? <ConfigWarning /> : <App />}
      </section>
    </main>
  );
}

function ConfigWarning() {
  return (
    <div className="rounded-lg border border-yellow-800 bg-yellow-950/40 p-4 text-sm text-yellow-200">
      <div className="font-semibold">Supabase not configured</div>
      <div className="mt-1 text-yellow-300/80">
        Copy <code>.env.local.example</code> to <code>.env.local</code> and set{" "}
        <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, then run{" "}
        <code>supabase/schema.sql</code> in the Supabase SQL editor.
      </div>
    </div>
  );
}

function App() {
  const [name, setName] = useState<string>("");
  const [nameHydrated, setNameHydrated] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState<string>("");

  useEffect(() => {
    const stored = localStorage.getItem(NAME_STORAGE_KEY) ?? "";
    setName(stored);
    setNameHydrated(true);
  }, []);

  if (!nameHydrated) return null;

  if (!name) {
    return (
      <NameGate
        onSet={(n) => {
          localStorage.setItem(NAME_STORAGE_KEY, n);
          setName(n);
        }}
      />
    );
  }

  if (!groupId) {
    return (
      <JoinGate
        onJoined={(id, gname) => {
          setGroupId(id);
          setGroupName(gname);
        }}
      />
    );
  }

  return (
    <Chat
      name={name}
      groupId={groupId}
      groupName={groupName}
      onChangeName={() => {
        localStorage.removeItem(NAME_STORAGE_KEY);
        setName("");
      }}
    />
  );
}

function NameGate({ onSet }: { onSet: (name: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-col gap-4">
      <label className="text-sm text-zinc-400">What&apos;s your name?</label>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. Dad"
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 p-3 text-zinc-100 outline-none focus:border-emerald-500"
      />
      <button
        onClick={() => value.trim() && onSet(value.trim())}
        disabled={!value.trim()}
        className="rounded-md bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        Continue
      </button>
    </div>
  );
}

function JoinGate({
  onJoined,
}: {
  onJoined: (groupId: string, groupName: string) => void;
}) {
  const [code, setCode] = useState(DEMO_JOIN_CODE);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setJoining(true);
    setError(null);
    const { data, error } = await supabase
      .from("groups")
      .select("id, name")
      .eq("join_code", c)
      .maybeSingle();
    setJoining(false);
    if (error) return setError(error.message);
    if (!data) return setError("No group with that code.");
    onJoined(data.id, data.name);
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="text-sm text-zinc-400">Join code</label>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="CHURCH1"
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 p-3 font-mono text-zinc-100 outline-none focus:border-emerald-500"
      />
      <button
        onClick={join}
        disabled={!code.trim() || joining}
        className="rounded-md bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        {joining ? "Joining…" : "Join group"}
      </button>
      {error && <div className="text-sm text-red-400">{error}</div>}
    </div>
  );
}

function Chat({
  name,
  groupId,
  groupName,
  onChangeName,
}: {
  name: string;
  groupId: string;
  groupName: string;
  onChangeName: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notifPermission, setNotifPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");

  const dingRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) setNotifPermission("unsupported");
    else setNotifPermission(Notification.permission);
    dingRef.current = new Audio(buildBeepDataUrl());
  }, []);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("alerts")
        .select("*")
        .eq("group_id", groupId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) setError(error.message);
      else setMessages((data ?? []) as Message[]);
    })();
  }, [groupId]);

  useEffect(() => {
    const channel = supabase
      .channel(`alerts:${groupId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "alerts",
          filter: `group_id=eq.${groupId}`,
        },
        (payload) => {
          const m = payload.new as Message;
          setMessages((prev) => {
            if (prev.some((x) => x.id === m.id)) return prev;
            return [m, ...prev].slice(0, 50);
          });
          if (m.is_alert) {
            dingRef.current?.play().catch(() => {});
            if (
              "Notification" in window &&
              Notification.permission === "granted"
            ) {
              new Notification(`🚨 ${m.sender_name}`, { body: m.message });
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [groupId]);

  async function send(asAlert: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    const { data, error } = await supabase
      .from("alerts")
      .insert({
        group_id: groupId,
        message: trimmed,
        sender_name: name,
        is_alert: asAlert,
      })
      .select()
      .single();
    setSending(false);
    if (error) return setError(error.message);
    setText("");
    setMessages((prev) => {
      if (prev.some((x) => x.id === (data as Message).id)) return prev;
      return [data as Message, ...prev].slice(0, 50);
    });
  }

  async function requestNotif() {
    if (!("Notification" in window)) return;
    const p = await Notification.requestPermission();
    setNotifPermission(p);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            {groupName}
          </div>
          <div className="mt-1 text-sm">
            Signed in as <span className="font-semibold">{name}</span>
          </div>
        </div>
        <button
          onClick={onChangeName}
          className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          change name
        </button>
      </div>

      {notifPermission === "default" && (
        <button
          onClick={requestNotif}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
        >
          Enable browser notifications
        </button>
      )}
      {notifPermission === "denied" && (
        <div className="rounded-md border border-yellow-800 bg-yellow-900/30 p-3 text-sm text-yellow-200">
          Notifications are blocked. You&apos;ll still hear the alert sound.
        </div>
      )}

      <div className="flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a message…"
          rows={2}
          className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-3 text-zinc-100 outline-none focus:border-emerald-500"
        />
        <div className="flex gap-2">
          <button
            onClick={() => send(false)}
            disabled={!text.trim() || sending}
            className="flex-1 rounded-md bg-emerald-600 px-4 py-2 font-semibold hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button
            onClick={() => send(true)}
            disabled={!text.trim() || sending}
            className="flex-1 rounded-md bg-red-600 px-4 py-2 font-semibold hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            Send as alert
          </button>
        </div>
        {error && <div className="text-sm text-red-400">{error}</div>}
      </div>

      <div className="flex flex-col gap-2">
        {messages.length === 0 && (
          <div className="text-sm text-zinc-600">No messages yet.</div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-md border p-3 ${
              m.is_alert
                ? "border-red-500/60 bg-red-950/30"
                : "border-zinc-800 bg-zinc-900/50"
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <div
                className={`text-xs font-semibold ${
                  m.is_alert ? "text-red-300" : "text-zinc-400"
                }`}
              >
                {m.is_alert ? "🚨 " : ""}
                {m.sender_name}
              </div>
              <div className="text-xs text-zinc-500">
                {new Date(m.created_at).toLocaleTimeString()}
              </div>
            </div>
            <div className="mt-1 text-base">{m.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildBeepDataUrl() {
  const sampleRate = 44100;
  const duration = 0.35;
  const freq = 880;
  const samples = Math.floor(sampleRate * duration);
  const data = new Uint8Array(44 + samples * 2);
  const view = new DataView(data.buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples * 2, true);

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t * 20) * Math.min(1, (duration - t) * 20);
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope * 0.5;
    view.setInt16(44 + i * 2, sample * 0x7fff, true);
  }

  let binary = "";
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  const base64 =
    typeof btoa !== "undefined"
      ? btoa(binary)
      : Buffer.from(binary, "binary").toString("base64");
  return `data:audio/wav;base64,${base64}`;
}
