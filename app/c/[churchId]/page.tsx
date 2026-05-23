"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  supabase,
  CHAT_MUTED_KEY,
  type Team,
  type TeamSlug,
  type Location,
  type LocationSlug,
} from "@/lib/supabase";
import {
  alertTone,
  bestPanicCoords,
  detectLocationInText,
  formatTimestamp,
  nearestLocationTo,
  primeGeolocation,
  startGeoWatch,
} from "@/lib/utils";
import { allClearUrl, chatPingUrl, play, sirenUrl } from "@/lib/audio";
import {
  enableNotifications,
  fanoutPush,
  pushSupportInitial,
  readAlertsOnly,
  registerServiceWorker,
  setAlertsOnly,
  syncPushTeams,
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

type Role = "owner" | "member";
type ViewMode = "team" | "join-list" | "everyone";
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
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [joinedTeams, setJoinedTeams] = useState<TeamSlug[]>([]);
  const [memberTeams, setMemberTeams] = useState<Record<string, TeamSlug[]>>(
    {}
  );
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [churchTeams, setChurchTeams] = useState<Team[]>([]);
  const [churchLocations, setChurchLocations] = useState<Location[]>([]);
  const [activeTeamIdx, setActiveTeamIdx] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("everyone");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [panicSending, setPanicSending] = useState(false);
  const [push, setPush] = useState<PushSupport>("default");
  const [alertsOnly, setAlertsOnlyState] = useState(false);
  const [savingAlertsOnly, setSavingAlertsOnly] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [mintedInvite, setMintedInvite] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [gpsBlocked, setGpsBlocked] = useState(false);
  const [chatMuted, setChatMuted] = useState(false);
  const [fixAccuracy, setFixAccuracy] = useState<number | null>(null);
  const chatMutedRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  // IDs of messages that just arrived via realtime — used to flash a
  // highlight ring for ~3.5s. Includes own sends so solo-testing shows
  // the glow too.
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  // Unread counters per chat tab. Cleared when the user switches into
  // that tab. Alerts are excluded — they show in every view.
  const [teamUnread, setTeamUnread] = useState(0);
  const [everyoneUnread, setEveryoneUnread] = useState(0);
  const viewModeRef = useRef<ViewMode>("everyone");
  const activeTeamRef = useRef<TeamSlug | null>(null);
  const joinedTeamsRef = useRef<TeamSlug[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(CHAT_MUTED_KEY);
    const initial = stored === "1";
    setChatMuted(initial);
    chatMutedRef.current = initial;
  }, []);

  const toggleMute = useCallback(() => {
    setChatMuted((prev) => {
      const next = !prev;
      chatMutedRef.current = next;
      try {
        window.localStorage.setItem(CHAT_MUTED_KEY, next ? "1" : "0");
      } catch {
        /* private mode / quota — ignore */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setPush(pushSupportInitial());
    registerServiceWorker();
    primeGeolocation();
    const stopWatch = startGeoWatch((fix) => setFixAccuracy(fix.accuracy));
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

      const [
        { data: profile },
        { data: membership },
        { data: church },
        { data: teamRows },
        { data: locationRows },
      ] = await Promise.all([
        supabase
          .from("profiles")
          .select("display_name")
          .eq("id", userData.user.id)
          .maybeSingle<{ display_name: string }>(),
        supabase
          .from("church_members")
          .select("role, joined_teams")
          .eq("user_id", userData.user.id)
          .eq("church_id", churchId)
          .maybeSingle<{ role: Role; joined_teams: string[] }>(),
        supabase
          .from("churches")
          .select("id, name")
          .eq("id", churchId)
          .maybeSingle<Church>(),
        supabase
          .from("church_teams")
          .select("slug, name, sort_order")
          .eq("church_id", churchId)
          .order("sort_order")
          .order("name")
          .returns<Team[]>(),
        supabase
          .from("church_locations")
          .select("slug, name, latitude, longitude, sort_order")
          .eq("church_id", churchId)
          .order("sort_order")
          .order("name")
          .returns<Location[]>(),
      ]);
      if (cancelled) return;

      if (!church) {
        setState({ kind: "error", message: "Church not found" });
        return;
      }
      if (!membership) {
        setState({
          kind: "error",
          message: "You're not a member of this church",
        });
        return;
      }
      const displayName = profile?.display_name ?? userData.user.email ?? "User";
      const teams = teamRows ?? [];
      const locations = locationRows ?? [];
      setChurchTeams(teams);
      setChurchLocations(locations);
      const teamSlugs = new Set(teams.map((t) => t.slug));
      const joined = (membership.joined_teams ?? []).filter((s) =>
        teamSlugs.has(s)
      );
      setJoinedTeams(joined);

      const { data: allMembers } = await supabase
        .from("church_members")
        .select("user_id, joined_teams, profiles(display_name)")
        .eq("church_id", churchId)
        .returns<
          {
            user_id: string;
            joined_teams: string[] | null;
            profiles: { display_name: string } | null;
          }[]
        >();
      if (cancelled) return;
      const teamsByUser: Record<string, TeamSlug[]> = {};
      const namesByUser: Record<string, string> = {};
      for (const row of allMembers ?? []) {
        teamsByUser[row.user_id] = (row.joined_teams ?? []).filter((s) =>
          teamSlugs.has(s)
        );
        if (row.profiles?.display_name) {
          namesByUser[row.user_id] = row.profiles.display_name;
        }
      }
      setMemberTeams(teamsByUser);
      setMemberNames(namesByUser);

      const initialAlertsOnly = await readAlertsOnly({
        churchId,
        userId: userData.user.id,
      });
      if (cancelled) return;
      setAlertsOnlyState(initialAlertsOnly);

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
      setHasMoreOlder((existing?.length ?? 0) === 200);
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

  const readyUserId = state.kind === "ready" ? state.userId : null;

  useEffect(() => {
    if (!readyUserId) return;
    const ch = supabase
      .channel(`chat:${churchId}`)
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "alerts",
          filter: `church_id=eq.${churchId}`,
        },
        (payload) => {
          const old = payload.old as { id?: string } | null;
          if (!old?.id) return;
          setMessages((prev) => prev.filter((m) => m.id !== old.id));
        }
      )
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
            const ownMessage = row.sender_id === readyUserId;
            const canNotify =
              !ownMessage &&
              typeof window !== "undefined" &&
              "Notification" in window &&
              Notification.permission === "granted";
            if (row.is_alert) {
              const tone = alertTone(row.message);
              if (tone === "standdown") play(allClearUrl());
              else play(sirenUrl());
              if (canNotify) {
                try {
                  const prefix =
                    tone === "panic"
                      ? "🚨"
                      : tone === "standdown"
                        ? "✅"
                        : "🔔";
                  new Notification(`${prefix} ${row.sender_name}`, {
                    body: row.message,
                    icon: "/icon-192.png",
                    tag: `alert-${row.id}`,
                    requireInteraction: tone === "panic",
                  });
                } catch {
                  /* notification API rejected — push fallback covers it */
                }
              }
            } else if (!ownMessage) {
              if (!chatMutedRef.current) play(chatPingUrl());
              if (canNotify) {
                try {
                  new Notification(`💬 ${row.sender_name}`, {
                    body: row.message,
                    icon: "/icon-192.png",
                    tag: `chat-${row.id}`,
                  });
                } catch {
                  /* notification API rejected — push fallback covers it */
                }
              }
            }
            setHighlightIds((s) => {
              const next = new Set(s);
              next.add(row.id);
              return next;
            });
            window.setTimeout(() => {
              setHighlightIds((s) => {
                if (!s.has(row.id)) return s;
                const next = new Set(s);
                next.delete(row.id);
                return next;
              });
            }, 3500);
            if (!ownMessage && !row.is_alert) {
              const isTeamMsg =
                row.team_slug !== null &&
                joinedTeamsRef.current.includes(row.team_slug);
              const isEveryoneMsg = row.team_slug === null;
              const onTeamChannel =
                viewModeRef.current === "team" &&
                row.team_slug !== null &&
                row.team_slug === activeTeamRef.current;
              const onEveryoneChannel =
                viewModeRef.current === "everyone" && isEveryoneMsg;
              if (isTeamMsg && !onTeamChannel) {
                setTeamUnread((n) => n + 1);
              } else if (isEveryoneMsg && !onEveryoneChannel) {
                setEveryoneUnread((n) => n + 1);
              }
            }
            return [row, ...prev];
          });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [readyUserId, churchId]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [messages.length]);

  const activeTeam: TeamSlug | null =
    joinedTeams.length > 0 ? joinedTeams[activeTeamIdx % joinedTeams.length] : null;

  useEffect(() => {
    viewModeRef.current = viewMode;
    if (viewMode === "team") setTeamUnread(0);
    if (viewMode === "everyone") setEveryoneUnread(0);
  }, [viewMode]);
  useEffect(() => {
    activeTeamRef.current = activeTeam;
    if (viewMode === "team") setTeamUnread(0);
  }, [activeTeam, viewMode]);
  useEffect(() => {
    joinedTeamsRef.current = joinedTeams;
  }, [joinedTeams]);

  const sendTeamSlug: TeamSlug | null =
    viewMode === "team" && activeTeam ? activeTeam : null;
  const channelLabel =
    viewMode === "team" && activeTeam
      ? churchTeams.find((t) => t.slug === activeTeam)?.name ?? activeTeam
      : "Everyone";

  const insertMessage = useCallback(
    async (opts: {
      message: string;
      isAlert: boolean;
      teamSlug: TeamSlug | null;
      attachGps: boolean;
    }): Promise<boolean> => {
      if (state.kind !== "ready") return false;
      const coords = opts.attachGps ? await bestPanicCoords() : null;
      const explicit = detectLocationInText(opts.message, churchLocations);
      const fromGps = coords
        ? nearestLocationTo(coords.latitude, coords.longitude, churchLocations)
        : null;
      const location = explicit ?? fromGps;
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
      if (inserted) {
        fanoutPush(inserted as Record<string, unknown>);
      }
      if (opts.attachGps && !coords) {
        setGpsBlocked(true);
      }
      return true;
    },
    [churchId, state, churchLocations]
  );

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = draft.trim();
      if (!text) return;
      setSending(true);
      try {
        const ok = await insertMessage({
          message: text,
          isAlert: false,
          teamSlug: sendTeamSlug,
          attachGps: false,
        });
        if (ok) setDraft("");
      } finally {
        setSending(false);
      }
    },
    [draft, sendTeamSlug, insertMessage]
  );

  const handleAlertTeam = useCallback(async () => {
    const text = draft.trim();
    if (!text) {
      window.alert("Type a message first.");
      return;
    }
    const targetName =
      sendTeamSlug
        ? churchTeams.find((t) => t.slug === sendTeamSlug)?.name ?? sendTeamSlug
        : "everyone";
    if (!window.confirm(`Send team alert to ${targetName}?`)) return;
    setPanicSending(true);
    try {
      const ok = await insertMessage({
        message: text,
        isAlert: true,
        teamSlug: sendTeamSlug,
        attachGps: true,
      });
      if (ok) setDraft("");
    } finally {
      setPanicSending(false);
    }
  }, [draft, sendTeamSlug, churchTeams, insertMessage]);

  const handlePanic = useCallback(async () => {
    if (!window.confirm("Send PANIC alert to everyone in this church?"))
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

  const persistJoinedTeams = useCallback(
    async (next: TeamSlug[]) => {
      if (state.kind !== "ready") return;
      const { error } = await supabase
        .rpc("update_joined_teams", {
          p_church_id: churchId,
          p_joined_teams: next,
        });
      if (error) {
        window.alert(`Could not save team change: ${error.message}`);
        return;
      }
      try {
        await syncPushTeams({
          churchId,
          userId: state.userId,
          joinedTeams: next,
        });
      } catch {
        /* push subscriptions are best-effort; membership is already saved */
      }
      setJoinedTeams(next);
      setMemberTeams((prev) => ({ ...prev, [state.userId]: next }));
    },
    [churchId, state]
  );

  const handleJoinTeam = useCallback(
    async (slug: TeamSlug) => {
      if (joinedTeams.includes(slug)) return;
      const next = [...joinedTeams, slug];
      await persistJoinedTeams(next);
      setActiveTeamIdx(next.length - 1);
      setViewMode("team");
    },
    [joinedTeams, persistJoinedTeams]
  );

  const handleLeaveTeam = useCallback(async () => {
    if (!activeTeam) return;
    const next = joinedTeams.filter((t) => t !== activeTeam);
    await persistJoinedTeams(next);
    setActiveTeamIdx(0);
    if (next.length === 0) setViewMode("everyone");
  }, [activeTeam, joinedTeams, persistJoinedTeams]);

  const cycleNext = useCallback(() => {
    if (joinedTeams.length === 0) return;
    setActiveTeamIdx((i) => (i + 1) % joinedTeams.length);
  }, [joinedTeams.length]);

  const cyclePrev = useCallback(() => {
    if (joinedTeams.length === 0) return;
    setActiveTeamIdx((i) => (i - 1 + joinedTeams.length) % joinedTeams.length);
  }, [joinedTeams.length]);

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
      /* leave the URL visible for manual copy */
    }
  }, [mintedInvite]);

  const refreshPicker = useCallback(() => {
    const el = inputRef.current;
    if (!el) {
      setPickerOpen(false);
      return;
    }
    const cursor = el.selectionStart ?? 0;
    const before = el.value.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");
    if (atIdx === -1) {
      setPickerOpen(false);
      return;
    }
    const token = before.slice(atIdx + 1);
    if (/\s/.test(token) || token.length > 32) {
      setPickerOpen(false);
      return;
    }
    setPickerQuery(token);
    setPickerOpen(true);
  }, []);

  const pickName = useCallback((name: string) => {
    const el = inputRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? 0;
    const before = el.value.slice(0, cursor);
    const atIdx = before.lastIndexOf("@");
    if (atIdx === -1) return;
    const replacement = `@${name} `;
    const after = el.value.slice(cursor);
    const next = el.value.slice(0, atIdx) + replacement + after;
    const newCursor = atIdx + replacement.length;
    setDraft(next);
    setPickerOpen(false);
    requestAnimationFrame(() => {
      if (!inputRef.current) return;
      inputRef.current.focus();
      inputRef.current.setSelectionRange(newCursor, newCursor);
    });
  }, []);

  const pickLocation = useCallback(
    (slug: LocationSlug) => {
      const el = inputRef.current;
      if (!el) return;
      const loc = churchLocations.find((l) => l.slug === slug);
      if (!loc) return;
      const cursor = el.selectionStart ?? 0;
      const before = el.value.slice(0, cursor);
      const atIdx = before.lastIndexOf("@");
      if (atIdx === -1) return;
      const replacement = `@${loc.name} `;
      const after = el.value.slice(cursor);
      const next = el.value.slice(0, atIdx) + replacement + after;
      const newCursor = atIdx + replacement.length;
      setDraft(next);
      setPickerOpen(false);
      requestAnimationFrame(() => {
        if (!inputRef.current) return;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(newCursor, newCursor);
      });
    },
    [churchLocations]
  );

  const handleLoadOlder = useCallback(async () => {
    if (loadingOlder || !hasMoreOlder || messages.length === 0) return;
    const oldest = messages[messages.length - 1];
    setLoadingOlder(true);
    try {
      const { data: older } = await supabase
        .from("alerts")
        .select(
          "id, church_id, message, sender_name, sender_id, is_alert, team_slug, location, latitude, longitude, created_at"
        )
        .eq("church_id", churchId)
        .lt("created_at", oldest.created_at)
        .order("created_at", { ascending: false })
        .limit(200)
        .returns<Message[]>();
      const rows = older ?? [];
      setMessages((prev) => [...prev, ...rows]);
      setHasMoreOlder(rows.length === 200);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, hasMoreOlder, messages, churchId]);

  const handleToggleAlertsOnly = useCallback(
    async (next: boolean) => {
      if (state.kind !== "ready") return;
      const prev = alertsOnly;
      setAlertsOnlyState(next);
      setSavingAlertsOnly(true);
      try {
        await setAlertsOnly({
          churchId,
          userId: state.userId,
          alertsOnly: next,
        });
      } catch (err) {
        setAlertsOnlyState(prev);
        window.alert(`Couldn't save preference: ${(err as Error).message}`);
      } finally {
        setSavingAlertsOnly(false);
      }
    },
    [state, alertsOnly, churchId]
  );

  const handleDeleteMessage = useCallback(
    async (id: string) => {
      if (state.kind !== "ready" || state.role !== "owner") return;
      if (!window.confirm("Delete this message for everyone?")) return;
      // Optimistic — realtime DELETE event will keep other clients in sync.
      setMessages((prev) => prev.filter((m) => m.id !== id));
      const { error } = await supabase.from("alerts").delete().eq("id", id);
      if (error) {
        window.alert(`Couldn't delete: ${error.message}`);
      }
    },
    [state]
  );

  const handleRename = useCallback(async () => {
    if (state.kind !== "ready") return;
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === state.displayName) return;
    setRenaming(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ display_name: trimmed })
        .eq("id", state.userId);
      if (error) {
        window.alert(`Couldn't save name: ${error.message}`);
        return;
      }
      setState({
        kind: "ready",
        church: state.church,
        userId: state.userId,
        role: state.role,
        displayName: trimmed,
      });
    } finally {
      setRenaming(false);
    }
  }, [state, nameDraft]);

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  }, [router]);

  const visible = useMemo(() => {
    return messages.filter((m) =>
      m.is_alert
        ? true
        : viewMode === "everyone"
          ? m.team_slug === null
          : viewMode === "team" && activeTeam
            ? m.team_slug === activeTeam
            : false
    );
  }, [messages, viewMode, activeTeam]);

  const myUserId = state.kind === "ready" ? state.userId : null;
  const teammates = useMemo(() => {
    if (!myUserId || joinedTeams.length === 0) return [];
    const myTeams = new Set(joinedTeams);
    return Object.entries(memberTeams)
      .filter(
        ([uid, teams]) =>
          uid !== myUserId && teams.some((t) => myTeams.has(t))
      )
      .map(([uid]) => ({ id: uid, displayName: memberNames[uid] ?? "" }))
      .filter((m) => m.displayName)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [memberTeams, memberNames, joinedTeams, myUserId]);

  // For pill rendering on receipt — we need every member's name even if
  // we don't share a team with them, so an "@John" from someone else's
  // team still renders as a pill on our screen.
  const allMembers = useMemo(
    () =>
      Object.entries(memberNames).map(([id, displayName]) => ({
        id,
        displayName,
      })),
    [memberNames]
  );

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

  const otherTeams = churchTeams.filter((t) => !joinedTeams.includes(t.slug));
  const showChat = viewMode === "team" || viewMode === "everyone";

  return (
    <main className="flex min-h-screen w-full flex-col bg-neutral-950 text-neutral-100">
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

      {fixAccuracy != null && fixAccuracy > 200 && (
        <p className="mx-3 mt-2 rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          GPS fix is ±{formatAccuracy(fixAccuracy)} — alerts may show the
          wrong block. iPhone: Settings → this app → Location →
          <strong> Precise Location ON</strong>, then go near a window.
        </p>
      )}

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
              onClick={toggleMute}
              title={
                chatMuted
                  ? "Chat ping sound is off (panic siren and push notifications still fire)"
                  : "Mute the in-app chat ping sound (push notifications are unaffected)"
              }
              className={`rounded border px-2 py-1 text-xs ${
                chatMuted
                  ? "border-neutral-700 text-neutral-500"
                  : "border-neutral-700 text-neutral-200"
              }`}
            >
              {chatMuted ? "🔇" : "🔊"}
            </button>
            <button
              type="button"
              onClick={async () => {
                if (push !== "default") return;
                const next = await enableNotifications({
                  churchId,
                  userId: state.userId,
                  senderName: state.displayName,
                  joinedTeams,
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
              onClick={() => {
                setProfileOpen((v) => {
                  const opening = !v;
                  if (opening) setNameDraft(state.displayName);
                  return opening;
                });
              }}
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
          <div className="mt-3 flex flex-col gap-3 border-t border-neutral-800 pt-3 text-sm">
            <div className="text-xs uppercase text-neutral-500">
              {state.role === "owner" ? "admin" : state.role}
            </div>
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              Display name
              <div className="flex gap-2">
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100"
                />
                <button
                  type="button"
                  onClick={handleRename}
                  disabled={
                    renaming ||
                    !nameDraft.trim() ||
                    nameDraft.trim() === state.displayName
                  }
                  className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 disabled:opacity-50"
                >
                  {renaming ? "Saving…" : "Save"}
                </button>
              </div>
            </label>
            <fieldset className="flex flex-col gap-1 text-xs text-neutral-400">
              <legend className="mb-1">Push notifications for this church</legend>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="alerts-only"
                  className="mt-0.5"
                  checked={!alertsOnly}
                  disabled={savingAlertsOnly || push !== "granted"}
                  onChange={() => handleToggleAlertsOnly(false)}
                />
                <span>
                  <span className="text-neutral-200">Every chat message</span>
                  <span className="block text-[11px] text-neutral-500">
                    Default. You&apos;ll feel every buzz.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="alerts-only"
                  className="mt-0.5"
                  checked={alertsOnly}
                  disabled={savingAlertsOnly || push !== "granted"}
                  onChange={() => handleToggleAlertsOnly(true)}
                />
                <span>
                  <span className="text-neutral-200">Alerts only</span>
                  <span className="block text-[11px] text-neutral-500">
                    Panic, team alerts, and stand-down only.
                  </span>
                </span>
              </label>
              {push !== "granted" && (
                <p className="mt-1 text-[11px] text-neutral-500">
                  Tap the 🔔 in the header to enable push first.
                </p>
              )}
            </fieldset>
            <Link href="/home" className="text-sm text-red-400 underline">
              ← Back to home
            </Link>
            {state.role === "owner" && (
              <>
                <Link
                  href={`/c/${churchId}/settings`}
                  className="self-start text-sm text-red-400 underline"
                >
                  Edit teams &amp; locations →
                </Link>
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
            <li>
              <strong>Installed as an app?</strong> Scroll the same screen
              → tap this app&apos;s name → Location → &ldquo;While Using&rdquo;
              → toggle <strong>Precise Location ON</strong>.
            </li>
            <li>
              <strong>Using Safari?</strong> Same screen → Safari Websites
              → &ldquo;While Using&rdquo;. In Safari: tap &ldquo;AA&rdquo; →
              Website Settings → Location → Allow.
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

      {viewMode === "team" && activeTeam && (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-2">
          <button
            type="button"
            onClick={cyclePrev}
            disabled={joinedTeams.length < 2}
            className="rounded border border-neutral-700 px-2 py-1 text-sm disabled:opacity-40"
            aria-label="Previous team"
          >
            ←
          </button>
          <div className="flex-1 text-center">
            <div className="text-sm font-semibold">
              {churchTeams.find((t) => t.slug === activeTeam)?.name}
            </div>
            <div className="text-xs text-neutral-500">
              {activeTeamIdx + 1} of {joinedTeams.length} team
              {joinedTeams.length === 1 ? "" : "s"}
            </div>
          </div>
          <button
            type="button"
            onClick={cycleNext}
            disabled={joinedTeams.length < 2}
            className="rounded border border-neutral-700 px-2 py-1 text-sm disabled:opacity-40"
            aria-label="Next team"
          >
            →
          </button>
          <button
            type="button"
            onClick={handleLeaveTeam}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300"
          >
            leave
          </button>
        </div>
      )}

      {showChat && (
        <form
          onSubmit={handleSend}
          className="mx-3 mt-3 flex flex-col gap-2 rounded border border-neutral-800 bg-neutral-900 p-3"
        >
          <div className="relative">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                refreshPicker();
              }}
              onKeyUp={refreshPicker}
              onClick={refreshPicker}
              onBlur={() =>
                setTimeout(() => setPickerOpen(false), 100)
              }
              placeholder={`Message ${channelLabel}… (type @ to tag a teammate or location)`}
              rows={2}
              className="block w-full resize-none bg-transparent text-base text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
            />
            {pickerOpen &&
              (() => {
                const q = pickerQuery.toLowerCase();
                const filteredPeople = teammates.filter(
                  (p) => q === "" || p.displayName.toLowerCase().includes(q)
                );
                const filteredLocs = churchLocations.filter(
                  (l) => q === "" || l.name.toLowerCase().includes(q)
                );
                if (filteredPeople.length === 0 && filteredLocs.length === 0)
                  return null;
                return (
                  <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded border border-neutral-700 bg-neutral-900 shadow-lg">
                    {filteredPeople.length > 0 && (
                      <li className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                        People on your teams
                      </li>
                    )}
                    {filteredPeople.map((p) => (
                      <li key={`p-${p.id}`}>
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pickName(p.displayName);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-100 hover:bg-neutral-800"
                        >
                          <span>👤</span>
                          {p.displayName}
                        </button>
                      </li>
                    ))}
                    {filteredLocs.length > 0 && (
                      <li className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                        Locations
                      </li>
                    )}
                    {filteredLocs.map((l) => (
                      <li key={`l-${l.slug}`}>
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pickLocation(l.slug);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-100 hover:bg-neutral-800"
                        >
                          <span>📍</span>
                          {l.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                );
              })()}
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={sending || !draft.trim()}
              className={`flex-1 rounded px-3 py-2 text-sm font-medium text-neutral-100 transition-colors disabled:opacity-50 ${
                draft.trim()
                  ? "bg-emerald-600 shadow-[0_0_0_1px_rgba(16,185,129,0.5)]"
                  : "bg-neutral-800"
              }`}
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
      )}

      {viewMode === "join-list" && (
        <div className="mx-3 mt-3 flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wide text-neutral-500">
            Teams to join
          </h2>
          {otherTeams.length === 0 ? (
            <p className="rounded border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-400">
              You&apos;re on every team in this church.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {otherTeams.map((t) => (
                <li
                  key={t.slug}
                  className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900 px-4 py-3"
                >
                  <span className="font-medium">{t.name}</span>
                  <button
                    type="button"
                    onClick={() => handleJoinTeam(t.slug)}
                    className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white"
                  >
                    Join
                  </button>
                </li>
              ))}
            </ul>
          )}
          {joinedTeams.length > 0 && (
            <p className="mt-1 text-xs text-neutral-500">
              On {joinedTeams.length} team{joinedTeams.length === 1 ? "" : "s"}
              {": "}
              {joinedTeams
                .map((s) => churchTeams.find((t) => t.slug === s)?.name)
                .join(", ")}
            </p>
          )}
        </div>
      )}

      {showChat && (
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
                const isNew = highlightIds.has(m.id);
                const highlightClass = isNew
                  ? " ring-2 ring-emerald-400/70 shadow-lg shadow-emerald-500/20 transition-shadow duration-700"
                  : " transition-shadow duration-700";
                const teamLabel = m.team_slug
                  ? churchTeams.find((t) => t.slug === m.team_slug)?.name ??
                    m.team_slug
                  : null;
                const locationLabel = m.location
                  ? churchLocations.find((l) => l.slug === m.location)?.name
                  : null;
                const senderTeamNames = (
                  m.sender_id ? memberTeams[m.sender_id] ?? [] : []
                )
                  .map((s) => churchTeams.find((t) => t.slug === s)?.name)
                  .filter((n): n is string => Boolean(n));
                return (
                  <li
                    key={m.id}
                    className={`flex flex-col ${cardClass}${highlightClass}`}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium text-neutral-100">
                        {tone === "panic" ? "🚨 " : ""}
                        {m.sender_name}
                      </span>
                      {senderTeamNames.length > 0 && (
                        <span className="flex flex-wrap gap-1">
                          {senderTeamNames.map((n) => (
                            <span
                              key={n}
                              className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400"
                            >
                              {n}
                            </span>
                          ))}
                        </span>
                      )}
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
                      {state.role === "owner" && (
                        <button
                          type="button"
                          onClick={() => handleDeleteMessage(m.id)}
                          aria-label="Delete message"
                          className="text-xs text-neutral-500 hover:text-red-400"
                        >
                          ×
                        </button>
                      )}
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
                      {renderMessageWithPills(
                        m.message,
                        churchLocations,
                        allMembers
                      )}
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
          {hasMoreOlder && visible.length > 0 && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={handleLoadOlder}
                disabled={loadingOlder}
                className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 disabled:opacity-50"
              >
                {loadingOlder ? "Loading…" : "Load older messages"}
              </button>
            </div>
          )}
          {(() => {
            const lastPanic = messages.find(
              (m) => m.is_alert && alertTone(m.message) === "panic"
            );
            if (!lastPanic) return null;
            const elapsedMs =
              Date.now() - new Date(lastPanic.created_at).getTime();
            const minutes = Math.floor(elapsedMs / 60_000);
            const elapsedLabel =
              minutes < 1
                ? "just now"
                : minutes === 1
                  ? "1 min ago"
                  : `${minutes} min ago`;
            return (
              <div className="mt-4 flex flex-col gap-2 rounded border border-amber-700/50 bg-amber-950/30 p-3">
                <p className="text-sm text-amber-200">
                  Active panic from{" "}
                  <span className="font-semibold">{lastPanic.sender_name}</span>{" "}
                  · {elapsedLabel}
                </p>
                <button
                  type="button"
                  onClick={handleStandDown}
                  disabled={panicSending}
                  className="rounded border border-emerald-700/60 px-4 py-2 text-sm font-medium text-emerald-300 disabled:opacity-50"
                >
                  Send Stand Down
                </button>
              </div>
            );
          })()}
        </div>
      )}

      {viewMode === "join-list" && <div className="flex-1" />}

      <nav className="sticky bottom-0 flex border-t border-neutral-800 bg-neutral-950/95 backdrop-blur">
        <BottomTab
          active={viewMode === "team"}
          label={
            activeTeam
              ? churchTeams.find((t) => t.slug === activeTeam)?.name ?? "Team"
              : "Pick team"
          }
          onClick={() => {
            if (joinedTeams.length === 0) {
              setViewMode("join-list");
            } else {
              setViewMode("team");
            }
          }}
          highlight
          unread={teamUnread}
        />
        {otherTeams.length > 0 && (
          <BottomTab
            active={viewMode === "join-list"}
            label="Other teams"
            onClick={() => setViewMode("join-list")}
          />
        )}
        <BottomTab
          active={viewMode === "everyone"}
          label="Everyone"
          onClick={() => setViewMode("everyone")}
          unread={everyoneUnread}
        />
      </nav>
    </main>
  );
}

// Replace every @LocationName / @MemberName token (case-insensitive,
// full canonical name) with a styled inline pill. Longer names match
// first so "@Main Sanctuary Entrance" doesn't get truncated to
// "@Main Sanctuary".
type Mentionable =
  | { kind: "loc"; name: string }
  | { kind: "person"; name: string };

function renderMessageWithPills(
  text: string,
  locations: Location[],
  members: { displayName: string }[]
): React.ReactNode[] {
  const items: Mentionable[] = [
    ...locations.map((l) => ({ kind: "loc" as const, name: l.name })),
    ...members.map((m) => ({ kind: "person" as const, name: m.displayName })),
  ];
  const sorted = items.sort((a, b) => b.name.length - a.name.length);
  const out: React.ReactNode[] = [];
  let i = 0;
  let buffer = "";
  const flush = () => {
    if (buffer) {
      out.push(<span key={`t${out.length}`}>{buffer}</span>);
      buffer = "";
    }
  };
  while (i < text.length) {
    if (text[i] === "@") {
      const remaining = text.slice(i + 1).toLowerCase();
      const match = sorted.find((m) =>
        remaining.startsWith(m.name.toLowerCase())
      );
      if (match) {
        flush();
        out.push(
          <span
            key={`p${out.length}`}
            className={
              match.kind === "loc"
                ? "inline-flex items-baseline gap-0.5 rounded bg-sky-900/40 px-1.5 py-0.5 align-baseline text-xs font-medium text-sky-200"
                : "inline-flex items-baseline gap-0.5 rounded bg-violet-900/40 px-1.5 py-0.5 align-baseline text-xs font-medium text-violet-200"
            }
          >
            {match.kind === "loc" ? `📍 ${match.name}` : `@${match.name}`}
          </span>
        );
        i += 1 + match.name.length;
        continue;
      }
    }
    buffer += text[i];
    i++;
  }
  flush();
  return out;
}

function formatAccuracy(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters)}m`;
}

function BottomTab({
  active,
  label,
  onClick,
  highlight,
  unread,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  highlight?: boolean;
  unread?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex-1 px-4 py-3 text-center text-sm ${
        active
          ? highlight
            ? "font-semibold text-emerald-400"
            : "font-semibold text-neutral-100"
          : "text-neutral-500"
      }`}
    >
      <span className="inline-flex items-center gap-1.5">
        {label}
        {unread && unread > 0 ? (
          <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </span>
    </button>
  );
}
