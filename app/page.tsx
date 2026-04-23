"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  supabase,
  hasSupabaseConfig,
  DEMO_JOIN_CODE,
  NAME_STORAGE_KEY,
  TEAMS,
  LOCATIONS,
  joinedTeamsKey,
  activeTeamKey,
  teamBySlug,
  isTeamSlug,
  locationBySlug,
  type Message,
  type TeamSlug,
  type LocationSlug,
} from "@/lib/supabase";

type Tab = "main" | "others" | "everyone";
type View = { kind: "everyone" } | { kind: "team"; slug: TeamSlug };
type GeoStatus = "unknown" | "granted" | "denied";

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

async function setupPushSubscription(
  churchId: string,
  senderName: string,
  joinedTeams: TeamSlug[]
): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (!VAPID_PUBLIC) return;
  if (Notification.permission !== "granted") return;
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
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
    await supabase.from("push_subscriptions").upsert(
      {
        church_id: churchId,
        sender_name: senderName,
        joined_teams: joinedTeams,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" }
    );
  } catch (err) {
    console.warn("push subscription setup failed:", err);
  }
}

async function tryGetPosition(opts: {
  timeoutMs: number;
}): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    return null;
  }
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: opts.timeoutMs,
        maximumAge: 60000,
      });
    });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return null;
  }
}

const lsSubscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};

function writeLocalStorage(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  if (value === null || value === "") localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

function useLocalStorageValue(key: string | null): string | null {
  const getSnapshot = useCallback(() => {
    if (!key) return "";
    return localStorage.getItem(key) ?? "";
  }, [key]);
  return useSyncExternalStore(lsSubscribe, getSnapshot, () => null);
}

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center bg-zinc-950 text-zinc-100">
      <header className="w-full border-b border-zinc-800 px-6 py-3">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <h1 className="text-base font-semibold tracking-tight">Church Alert</h1>
        </div>
      </header>

      <section className="mx-auto w-full max-w-2xl flex-1 px-6 py-6">
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
  const name = useLocalStorageValue(NAME_STORAGE_KEY);
  const [churchId, setChurchId] = useState<string | null>(null);
  const [churchName, setChurchName] = useState<string>("");

  if (name === null) return null;

  if (!name) {
    return <NameGate onSet={(n) => writeLocalStorage(NAME_STORAGE_KEY, n)} />;
  }

  if (!churchId) {
    return (
      <JoinChurchGate
        onJoined={(id, cname) => {
          setChurchId(id);
          setChurchName(cname);
        }}
      />
    );
  }

  return (
    <AppShell
      name={name}
      churchId={churchId}
      churchName={churchName}
      onChangeName={() => writeLocalStorage(NAME_STORAGE_KEY, null)}
      onChangeChurch={() => {
        setChurchId(null);
        setChurchName("");
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

function JoinChurchGate({
  onJoined,
}: {
  onJoined: (churchId: string, churchName: string) => void;
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
      .from("churches")
      .select("id, name")
      .eq("join_code", c)
      .maybeSingle();
    setJoining(false);
    if (error) return setError(error.message);
    if (!data) return setError("No church with that code.");
    onJoined(data.id, data.name);
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="text-sm text-zinc-400">Church join code</label>
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
        {joining ? "Joining…" : "Join church"}
      </button>
      {error && <div className="text-sm text-red-400">{error}</div>}
    </div>
  );
}

function AppShell({
  name,
  churchId,
  churchName,
  onChangeName,
  onChangeChurch,
}: {
  name: string;
  churchId: string;
  churchName: string;
  onChangeName: () => void;
  onChangeChurch: () => void;
}) {
  const rawJoined = useLocalStorageValue(joinedTeamsKey(churchId));
  const joinedTeams = useMemo<TeamSlug[]>(() => {
    if (!rawJoined) return [];
    try {
      const parsed = JSON.parse(rawJoined) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isTeamSlug) : [];
    } catch {
      return [];
    }
  }, [rawJoined]);

  const rawActive = useLocalStorageValue(activeTeamKey(churchId));
  const activeTeam: TeamSlug | null =
    isTeamSlug(rawActive) && joinedTeams.includes(rawActive)
      ? rawActive
      : joinedTeams[0] ?? null;

  const [tab, setTab] = useState<Tab>("main");
  const [unreadTeams, setUnreadTeams] = useState<Set<TeamSlug>>(new Set());
  const [panicOpen, setPanicOpen] = useState(false);
  const [panicSending, setPanicSending] = useState(false);
  const [panicError, setPanicError] = useState<string | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("unknown");

  useEffect(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => setGeoStatus("granted"),
      (err) =>
        setGeoStatus(
          err && err.code === err.PERMISSION_DENIED ? "denied" : "unknown"
        ),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("service worker register failed:", err);
    });
  }, []);

  useEffect(() => {
    setupPushSubscription(churchId, name, joinedTeams);
  }, [churchId, name, joinedTeams]);

  useEffect(() => {
    if (geoStatus !== "granted") return;
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      return;
    }
    const id = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        () => {},
        () => {},
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    }, 60000);
    return () => clearInterval(id);
  }, [geoStatus]);

  const joinedTeamsRef = useRef(joinedTeams);
  const activeTeamRef = useRef(activeTeam);
  const tabRef = useRef(tab);
  useEffect(() => {
    joinedTeamsRef.current = joinedTeams;
  }, [joinedTeams]);
  useEffect(() => {
    activeTeamRef.current = activeTeam;
  }, [activeTeam]);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    const channel = supabase
      .channel(`unread:${churchId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "alerts",
          filter: `church_id=eq.${churchId}`,
        },
        (payload) => {
          const m = payload.new as Message;
          if (!m.team_slug) return;
          const slug = m.team_slug;
          if (!joinedTeamsRef.current.includes(slug)) return;
          if (tabRef.current === "main" && activeTeamRef.current === slug) return;
          setUnreadTeams((prev) => {
            if (prev.has(slug)) return prev;
            const next = new Set(prev);
            next.add(slug);
            return next;
          });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [churchId]);

  function clearUnread(slug: TeamSlug | null) {
    if (!slug) return;
    setUnreadTeams((prev) => {
      if (!prev.has(slug)) return prev;
      const next = new Set(prev);
      next.delete(slug);
      return next;
    });
  }

  function persistJoined(next: TeamSlug[]) {
    writeLocalStorage(joinedTeamsKey(churchId), JSON.stringify(next));
  }
  function persistActive(slug: TeamSlug | null) {
    writeLocalStorage(activeTeamKey(churchId), slug);
  }

  function joinTeam(slug: TeamSlug) {
    if (!joinedTeams.includes(slug)) {
      persistJoined([...joinedTeams, slug]);
    }
    persistActive(slug);
    setTab("main");
    clearUnread(slug);
  }

  function leaveActive() {
    if (!activeTeam) return;
    const next = joinedTeams.filter((s) => s !== activeTeam);
    persistJoined(next);
    const newActive = next[0] ?? null;
    persistActive(newActive);
    clearUnread(activeTeam);
    clearUnread(newActive);
  }

  function cycle(direction: 1 | -1) {
    if (joinedTeams.length < 2 || !activeTeam) return;
    const idx = joinedTeams.indexOf(activeTeam);
    const nextIdx =
      (idx + direction + joinedTeams.length) % joinedTeams.length;
    const nextSlug = joinedTeams[nextIdx];
    persistActive(nextSlug);
    clearUnread(nextSlug);
  }

  function selectTab(t: Tab) {
    setTab(t);
    if (t === "main" && activeTeam) clearUnread(activeTeam);
  }

  async function sendPanic() {
    setPanicSending(true);
    setPanicError(null);

    // 5s is enough when the cache is warm; panic shouldn't hang on a cold GPS.
    const coords = await tryGetPosition({ timeoutMs: 5000 });

    const { error } = await supabase.from("alerts").insert({
      church_id: churchId,
      team_slug: null,
      location: null,
      latitude: coords?.lat ?? null,
      longitude: coords?.lng ?? null,
      message: "PANIC — emergency help needed",
      sender_name: name,
      is_alert: true,
    });

    setPanicSending(false);
    if (error) {
      setPanicError(error.message);
      return;
    }
    setPanicOpen(false);
  }

  const canCycle = joinedTeams.length > 1;

  function cycleTarget(dir: 1 | -1): TeamSlug | null {
    if (!canCycle || !activeTeam) return null;
    const idx = joinedTeams.indexOf(activeTeam);
    return joinedTeams[(idx + dir + joinedTeams.length) % joinedTeams.length];
  }
  const prevTarget = cycleTarget(-1);
  const nextTarget = cycleTarget(1);
  const unreadPrev = prevTarget ? unreadTeams.has(prevTarget) : false;
  const unreadNext = nextTarget ? unreadTeams.has(nextTarget) : false;

  return (
    <div className="flex flex-col gap-4 pb-20">
      <PanicBar
        onPanic={() => {
          setPanicError(null);
          setPanicOpen(true);
        }}
      />
      <ProfileStrip
        name={name}
        churchName={churchName}
        onChangeName={onChangeName}
        onChangeChurch={onChangeChurch}
      />

      {tab === "main" &&
        (activeTeam ? (
          <Chat
            key={`main:${activeTeam}`}
            name={name}
            churchId={churchId}
            joinedTeams={joinedTeams}
            view={{ kind: "team", slug: activeTeam }}
            title={teamBySlug(activeTeam).name}
            subtitle={
              canCycle
                ? `${joinedTeams.indexOf(activeTeam) + 1} of ${joinedTeams.length} teams`
                : "your team"
            }
            onPrev={canCycle ? () => cycle(-1) : undefined}
            onNext={canCycle ? () => cycle(1) : undefined}
            onLeave={() => leaveActive()}
            unreadPrev={unreadPrev}
            unreadNext={unreadNext}
          />
        ) : (
          <PickFirstTeam onPick={(slug) => joinTeam(slug)} />
        ))}

      {tab === "others" && (
        <OthersList joinedTeams={joinedTeams} onJoin={(slug) => joinTeam(slug)} />
      )}

      {tab === "everyone" && (
        <Chat
          key="everyone"
          name={name}
          churchId={churchId}
          joinedTeams={joinedTeams}
          view={{ kind: "everyone" }}
          title="Everyone"
          subtitle="church-wide"
        />
      )}

      <TabBar
        current={tab}
        onSelect={selectTab}
        mainTeamLabel={
          activeTeam ? teamBySlug(activeTeam).name : "My teams"
        }
      />

      {panicOpen && (
        <PanicConfirmModal
          sending={panicSending}
          error={panicError}
          geoStatus={geoStatus}
          onCancel={() => {
            if (panicSending) return;
            setPanicOpen(false);
            setPanicError(null);
          }}
          onConfirm={sendPanic}
        />
      )}
    </div>
  );
}

function PanicConfirmModal({
  sending,
  error,
  geoStatus,
  onCancel,
  onConfirm,
}: {
  sending: boolean;
  error: string | null;
  geoStatus: GeoStatus;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-red-600 bg-zinc-900 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold text-red-300">
          Send PANIC alert?
        </div>
        <div className="mt-2 text-sm text-zinc-300">
          This notifies <span className="font-semibold">everyone</span> in the
          church and shares your current GPS location.
        </div>
        {geoStatus === "denied" && (
          <div className="mt-3 rounded border border-yellow-800 bg-yellow-950/40 p-2 text-xs text-yellow-200">
            📍 Location is blocked in your browser — this alert will still send,
            without GPS.
          </div>
        )}
        {error && (
          <div className="mt-3 rounded border border-red-700 bg-red-950/40 p-2 text-sm text-red-300">
            {error}
          </div>
        )}
        <div className="mt-5 flex gap-2">
          <button
            onClick={onCancel}
            disabled={sending}
            className="flex-1 rounded-md border border-zinc-700 px-4 py-2 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={sending}
            className="flex-1 rounded-md bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {sending ? "Sending…" : "🚨 Send alert"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileStrip({
  name,
  churchName,
  onChangeName,
  onChangeChurch,
}: {
  name: string;
  churchName: string;
  onChangeName: () => void;
  onChangeChurch: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm">
      <div className="truncate">
        <span className="text-zinc-500">{churchName}</span>
        <span className="mx-1.5 text-zinc-700">·</span>
        <span className="font-semibold">{name}</span>
      </div>
      <div className="flex gap-1">
        <button
          onClick={onChangeName}
          className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          name
        </button>
        <button
          onClick={onChangeChurch}
          className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          church
        </button>
      </div>
    </div>
  );
}

function PickFirstTeam({ onPick }: { onPick: (slug: TeamSlug) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-semibold">Pick a team to join</div>
      <div className="text-xs text-zinc-500">
        You can join more from the Other teams tab.
      </div>
      <div className="flex flex-col gap-2">
        {TEAMS.map((t) => (
          <button
            key={t.slug}
            onClick={() => onPick(t.slug)}
            className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-left hover:bg-zinc-800"
          >
            <div className="font-semibold">{t.name}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function OthersList({
  joinedTeams,
  onJoin,
}: {
  joinedTeams: TeamSlug[];
  onJoin: (slug: TeamSlug) => void;
}) {
  const others = TEAMS.filter((t) => !joinedTeams.includes(t.slug));
  if (others.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
        You&apos;re in every team.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="px-1 text-xs uppercase tracking-wide text-zinc-500">
        Teams to join
      </div>
      {others.map((t) => (
        <div
          key={t.slug}
          className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
        >
          <div className="font-semibold">{t.name}</div>
          <button
            onClick={() => onJoin(t.slug)}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            Join
          </button>
        </div>
      ))}
    </div>
  );
}

function TabBar({
  current,
  onSelect,
  mainTeamLabel,
}: {
  current: Tab;
  onSelect: (t: Tab) => void;
  mainTeamLabel: string;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "main", label: mainTeamLabel },
    { id: "others", label: "Other teams" },
    { id: "everyone", label: "Everyone" },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-2xl">
        {tabs.map((t) => {
          const active = current === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={`flex-1 truncate px-2 py-3 text-xs ${
                active
                  ? "font-semibold text-emerald-400"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function PanicBar({ onPanic }: { onPanic: () => void }) {
  return (
    <div className="sticky top-0 z-10 -mx-6 -mt-6 bg-zinc-950/95 px-6 pt-3 pb-2 backdrop-blur">
      <button
        onClick={onPanic}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-red-700 px-4 py-3 text-sm font-bold uppercase tracking-wide text-white shadow-md shadow-red-900/40 hover:bg-red-600 active:bg-red-800"
        aria-label="Send panic alert to everyone in the church"
      >
        <span className="text-base">🚨</span>
        <span>Panic — church-wide alert</span>
      </button>
    </div>
  );
}

function Chat({
  name,
  churchId,
  joinedTeams,
  view,
  title,
  subtitle,
  onPrev,
  onNext,
  onLeave,
  unreadPrev = false,
  unreadNext = false,
}: {
  name: string;
  churchId: string;
  joinedTeams: TeamSlug[];
  view: View;
  title: string;
  subtitle?: string;
  onPrev?: () => void;
  onNext?: () => void;
  onLeave?: () => void;
  unreadPrev?: boolean;
  unreadNext?: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [mention, setMention] = useState<{ start: number; query: string } | null>(
    null
  );
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [notifPermission, setNotifPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");

  const dingRef = useRef<HTMLAudioElement | null>(null);
  const joinedTeamsRef = useRef(joinedTeams);
  useEffect(() => {
    joinedTeamsRef.current = joinedTeams;
  }, [joinedTeams]);

  const isEveryone = view.kind === "everyone";
  const teamSlug = view.kind === "team" ? view.slug : null;
  const viewKey = isEveryone ? "everyone" : `team:${teamSlug}`;

  function matchesView(m: Message): boolean {
    if (isEveryone) return m.team_slug === null;
    // Team view shows team messages AND surfaces church-wide alerts inline.
    return m.team_slug === teamSlug || (m.team_slug === null && m.is_alert);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) setNotifPermission("unsupported");
    else setNotifPermission(Notification.permission);
    dingRef.current = new Audio(buildBeepDataUrl());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q = supabase
        .from("alerts")
        .select("*")
        .eq("church_id", churchId)
        .order("created_at", { ascending: false })
        .limit(50);

      if (isEveryone) {
        q = q.is("team_slug", null);
      } else if (teamSlug) {
        q = q.or(
          `team_slug.eq.${teamSlug},and(team_slug.is.null,is_alert.eq.true)`
        );
      }

      const { data, error } = await q;
      if (cancelled) return;
      if (error) setError(error.message);
      else setMessages((data ?? []) as Message[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [churchId, isEveryone, teamSlug]);

  useEffect(() => {
    const channel = supabase
      .channel(`alerts:${churchId}:${viewKey}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "alerts",
          filter: `church_id=eq.${churchId}`,
        },
        (payload) => {
          const m = payload.new as Message;
          const show = matchesView(m);

          if (show) {
            setMessages((prev) => {
              if (prev.some((x) => x.id === m.id)) return prev;
              return [m, ...prev].slice(0, 50);
            });
          }

          if (m.is_alert) {
            const isEveryoneAlert = m.team_slug === null;
            const isJoinedTeamAlert =
              m.team_slug !== null &&
              joinedTeamsRef.current.includes(m.team_slug);
            if (show || isEveryoneAlert || isJoinedTeamAlert) {
              dingRef.current?.play().catch(() => {});
              if (
                "Notification" in window &&
                Notification.permission === "granted"
              ) {
                const label = isEveryoneAlert
                  ? "Everyone"
                  : teamBySlug(m.team_slug as TeamSlug).name;
                new Notification(`🚨 ${m.sender_name} · ${label}`, {
                  body: notifBody(m.message),
                });
              }
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [churchId, viewKey]);

  function updateMention(val: string, cursor: number) {
    const before = val.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");
    if (atIdx === -1) return setMention(null);
    if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) return setMention(null);
    const query = before.slice(atIdx + 1);
    if (/\s/.test(query)) return setMention(null);
    setMention({ start: atIdx, query });
    setHighlight(0);
  }

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!mention || mentionMatches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % mentionMatches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight(
        (h) => (h - 1 + mentionMatches.length) % mentionMatches.length
      );
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const loc = mentionMatches[effectiveHighlight];
      if (loc) insertMention(loc.slug);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMention(null);
    }
  }

  function insertMention(slug: LocationSlug) {
    const loc = locationBySlug(slug);
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    const next = `${before}@${loc.name} ${after}`;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const caret = before.length + 1 + loc.name.length + 1;
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  }

  async function send(asAlert: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);

    // Only alerts carry GPS; regular chat messages don't need it.
    // Short timeout since AppShell keeps the position cache warm.
    const coords = asAlert
      ? await tryGetPosition({ timeoutMs: 3000 })
      : null;

    const { data, error } = await supabase
      .from("alerts")
      .insert({
        church_id: churchId,
        team_slug: teamSlug,
        location: detectLocationInText(trimmed),
        latitude: coords?.lat ?? null,
        longitude: coords?.lng ?? null,
        message: trimmed,
        sender_name: name,
        is_alert: asAlert,
      })
      .select()
      .single();
    setSending(false);
    if (error) return setError(error.message);
    setText("");
    setMention(null);
    const m = data as Message;
    if (matchesView(m)) {
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        return [m, ...prev].slice(0, 50);
      });
    }
  }

  const mentionMatches =
    mention === null
      ? []
      : LOCATIONS.filter((l) =>
          l.name.toLowerCase().startsWith(mention.query.toLowerCase())
        );
  const effectiveHighlight =
    mentionMatches.length === 0
      ? 0
      : Math.max(0, Math.min(highlight, mentionMatches.length - 1));

  async function requestNotif() {
    if (!("Notification" in window)) return;
    const p = await Notification.requestPermission();
    setNotifPermission(p);
  }

  const alertLabel = isEveryone ? "Alert everyone" : "Alert team";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        {onPrev && (
          <button
            onClick={onPrev}
            className="relative shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
            aria-label={
              unreadPrev ? "Previous team (unread)" : "Previous team"
            }
          >
            ←
            {unreadPrev && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-zinc-900" />
            )}
          </button>
        )}
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-semibold">{title}</div>
          {subtitle && (
            <div className="truncate text-xs text-zinc-500">{subtitle}</div>
          )}
        </div>
        {onNext && (
          <button
            onClick={onNext}
            className="relative shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
            aria-label={unreadNext ? "Next team (unread)" : "Next team"}
          >
            →
            {unreadNext && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-zinc-900" />
            )}
          </button>
        )}
        {onLeave && (
          <button
            onClick={onLeave}
            className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            leave
          </button>
        )}
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
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              updateMention(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const ta = e.currentTarget;
              updateMention(ta.value, ta.selectionStart);
            }}
            onKeyDown={onTextareaKeyDown}
            onBlur={() => {
              // Delay so clicks on the picker register first.
              setTimeout(() => setMention(null), 150);
            }}
            placeholder={
              isEveryone
                ? "Message the whole church… (type @ to tag a location)"
                : `Message ${title}… (type @ to tag a location)`
            }
            rows={2}
            className="w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-3 text-zinc-100 outline-none focus:border-emerald-500"
          />
          {mention !== null && mentionMatches.length > 0 && (
            <div
              className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-56 overflow-y-auto overscroll-contain rounded-md border border-zinc-700 bg-zinc-900 shadow-lg"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="sticky top-0 border-b border-zinc-800 bg-zinc-900 px-3 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
                📍 Location
              </div>
              {mentionMatches.map((l, i) => (
                <button
                  key={l.slug}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => insertMention(l.slug)}
                  className={`block w-full px-3 py-2 text-left text-sm ${
                    i === effectiveHighlight
                      ? "bg-zinc-800 text-emerald-200"
                      : "hover:bg-zinc-800"
                  }`}
                >
                  📍 {l.name}
                </button>
              ))}
            </div>
          )}
        </div>
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
            className="flex-1 rounded-md bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {alertLabel}
          </button>
        </div>
        {error && <div className="text-sm text-red-400">{error}</div>}
      </div>

      <div className="flex flex-col gap-2">
        {messages.length === 0 && (
          <div className="text-sm text-zinc-600">No messages yet.</div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} showChannelTag={!isEveryone} />
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  m,
  showChannelTag,
}: {
  m: Message;
  showChannelTag: boolean;
}) {
  const channelLabel =
    m.team_slug === null ? "Everyone" : teamBySlug(m.team_slug).name;
  const crossChannel = showChannelTag && m.team_slug === null;
  return (
    <div
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
          {crossChannel && (
            <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-200">
              {channelLabel}
            </span>
          )}
        </div>
        <div className="text-xs text-zinc-500">
          {formatTimestamp(m.created_at)}
        </div>
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-base">
        {renderMessageBody(m.message)}
      </div>
      {typeof m.latitude === "number" && typeof m.longitude === "number" && (
        <a
          href={`https://www.google.com/maps?q=${m.latitude},${m.longitude}`}
          target="_blank"
          rel="noreferrer"
          className={`mt-2 inline-flex items-center gap-1 text-xs font-semibold underline ${
            m.is_alert ? "text-red-200" : "text-emerald-300"
          }`}
        >
          📍 View sender&apos;s GPS on map ↗
        </a>
      )}
    </div>
  );
}

function renderMessageBody(text: string): ReactNode[] {
  const lower = text.toLowerCase();
  const hits: { idx: number; len: number; name: string }[] = [];
  for (const l of LOCATIONS) {
    const needle = `@${l.name.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      hits.push({ idx, len: needle.length, name: l.name });
      from = idx + needle.length;
    }
  }
  hits.sort((a, b) => a.idx - b.idx);
  const nonOverlap: typeof hits = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.idx >= lastEnd) {
      nonOverlap.push(h);
      lastEnd = h.idx + h.len;
    }
  }

  const out: ReactNode[] = [];
  let pos = 0;
  nonOverlap.forEach((h, i) => {
    if (h.idx > pos) {
      out.push(<span key={`t${i}`}>{text.slice(pos, h.idx)}</span>);
    }
    out.push(
      <span
        key={`l${i}`}
        className="mx-0.5 inline-flex items-baseline gap-0.5 rounded bg-emerald-500/20 px-1.5 py-0.5 text-sm font-medium text-emerald-200"
      >
        📍 {h.name}
      </span>
    );
    pos = h.idx + h.len;
  });
  if (pos < text.length) {
    out.push(<span key="tend">{text.slice(pos)}</span>);
  }
  return out;
}

function notifBody(text: string): string {
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

function formatTimestamp(iso: string): string {
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

function detectLocationInText(text: string): LocationSlug | null {
  const lower = text.toLowerCase();
  for (const l of LOCATIONS) {
    if (lower.includes(`@${l.name.toLowerCase()}`)) return l.slug;
  }
  return null;
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
