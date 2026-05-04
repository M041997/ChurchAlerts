"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/utils";
import type { User } from "@supabase/supabase-js";

type Profile = { id: string; display_name: string };
type Membership = {
  church_id: string;
  role: "owner" | "member";
  churches: { id: string; name: string } | null;
};
type Member = {
  user_id: string;
  role: "owner" | "member";
  profiles: { id: string; display_name: string } | null;
};

export default function HomePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [mintedInvite, setMintedInvite] = useState<{
    churchId: string;
    url: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Members tab state — keyed by church_id so each church card can
  // independently toggle its roster panel.
  const [expandedChurch, setExpandedChurch] = useState<string | null>(null);
  const [membersByChurch, setMembersByChurch] = useState<Record<string, Member[]>>(
    {}
  );

  const refresh = useCallback(async () => {
    const { data: authData } = await supabase.auth.getUser();
    const uid = authData.user?.id;
    if (!uid) {
      setProfile(null);
      setMemberships([]);
      return;
    }

    const { data: prof } = await supabase
      .from("profiles")
      .select("id, display_name")
      .eq("id", uid)
      .maybeSingle<Profile>();
    setProfile(prof ?? null);

    const { data: mems } = await supabase
      .from("church_members")
      .select("church_id, role, churches(id, name)")
      .eq("user_id", uid)
      .returns<Membership[]>();
    setMemberships(mems ?? []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!data.user) {
        router.replace("/login");
        return;
      }
      setUser(data.user);
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, refresh]);

  async function loadMembers(churchId: string) {
    const { data, error: err } = await supabase
      .from("church_members")
      .select("user_id, role, profiles(id, display_name)")
      .eq("church_id", churchId)
      .returns<Member[]>();
    if (err) {
      setError(errorMessage(err));
      return;
    }
    setMembersByChurch((prev) => ({ ...prev, [churchId]: data ?? [] }));
  }

  async function toggleMembers(churchId: string) {
    setError(null);
    if (expandedChurch === churchId) {
      setExpandedChurch(null);
      return;
    }
    setExpandedChurch(churchId);
    if (!membersByChurch[churchId]) {
      await loadMembers(churchId);
    }
  }

  async function handleRemoveMember(churchId: string, userId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this church?`)) return;
    setError(null);
    const { error: err } = await supabase
      .from("church_members")
      .delete()
      .eq("church_id", churchId)
      .eq("user_id", userId);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    await loadMembers(churchId);
  }

  async function handlePromoteMember(
    churchId: string,
    userId: string,
    name: string
  ) {
    if (!window.confirm(`Make ${name} an admin? Admins can mint invites and delete messages.`))
      return;
    setError(null);
    const { error: err } = await supabase.rpc("promote_member", {
      p_user_id: userId,
      p_church_id: churchId,
    });
    if (err) {
      setError(errorMessage(err));
      return;
    }
    await loadMembers(churchId);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  async function handleMintInvite(churchId: string) {
    setError(null);
    setMintedInvite(null);
    try {
      const { data: token, error: rpcErr } = await supabase.rpc(
        "create_invite",
        { p_church_id: churchId }
      );
      if (rpcErr || !token) throw rpcErr ?? new Error("No token returned");
      const url = `${window.location.origin}/join/${token}`;
      setMintedInvite({ churchId, url });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (loading) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-sm items-center justify-center px-6 py-12 text-sm text-gray-500">
        Loading…
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col gap-6 px-6 py-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">
          Hi, {profile?.display_name ?? user?.email}
        </h1>
        <button
          onClick={handleSignOut}
          className="text-sm text-gray-500 underline"
        >
          Sign out
        </button>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500">
          Your churches
        </h2>
        {memberships.length === 0 ? (
          <p className="text-sm text-gray-500">
            You&apos;re not in any church yet. Ask an admin for an invite
            link.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {memberships.map((m) => {
              const isAdmin = m.role === "owner";
              const expanded = expandedChurch === m.church_id;
              const members = membersByChurch[m.church_id] ?? [];
              return (
                <li
                  key={m.church_id}
                  className="flex flex-col gap-2 rounded border border-gray-200 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{m.churches?.name}</span>
                    <span className="text-xs uppercase text-gray-500">
                      {isAdmin ? "admin" : m.role}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={`/c/${m.church_id}`}
                      className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white"
                    >
                      Open chat
                    </Link>
                    {isAdmin && (
                      <button
                        onClick={() => handleMintInvite(m.church_id)}
                        className="rounded border border-gray-300 px-3 py-1 text-sm"
                      >
                        Mint invite link
                      </button>
                    )}
                    {isAdmin && (
                      <Link
                        href={`/c/${m.church_id}/settings`}
                        className="rounded border border-gray-300 px-3 py-1 text-sm"
                      >
                        Settings
                      </Link>
                    )}
                    <button
                      onClick={() => toggleMembers(m.church_id)}
                      className="rounded border border-gray-300 px-3 py-1 text-sm"
                    >
                      {expanded ? "Hide members" : "Members"}
                    </button>
                  </div>
                  {mintedInvite?.churchId === m.church_id && (
                    <div className="flex flex-col gap-1 rounded bg-gray-100 p-2 text-xs">
                      <span className="text-gray-500">Single-use link:</span>
                      <code className="break-all">{mintedInvite.url}</code>
                    </div>
                  )}
                  {expanded && (
                    <div className="mt-1 flex flex-col gap-2 border-t border-gray-200 pt-2">
                      {members.length === 0 ? (
                        <p className="text-xs text-gray-500">Loading…</p>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {members.map((mem) => {
                            const name =
                              mem.profiles?.display_name ?? "(unknown)";
                            const isSelf = mem.user_id === user?.id;
                            const isMemAdmin = mem.role === "owner";
                            return (
                              <li
                                key={mem.user_id}
                                className="flex items-center justify-between gap-2 text-sm"
                              >
                                <span>
                                  {name}
                                  {isSelf && (
                                    <span className="ml-1 text-xs text-gray-400">
                                      (you)
                                    </span>
                                  )}
                                  <span className="ml-2 text-xs uppercase text-gray-400">
                                    {isMemAdmin ? "admin" : "member"}
                                  </span>
                                </span>
                                {isAdmin && !isSelf && (
                                  <span className="flex gap-1">
                                    {!isMemAdmin && (
                                      <button
                                        onClick={() =>
                                          handlePromoteMember(
                                            m.church_id,
                                            mem.user_id,
                                            name
                                          )
                                        }
                                        className="rounded border border-gray-300 px-2 py-0.5 text-xs"
                                      >
                                        Make admin
                                      </button>
                                    )}
                                    <button
                                      onClick={() =>
                                        handleRemoveMember(
                                          m.church_id,
                                          mem.user_id,
                                          name
                                        )
                                      }
                                      className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700"
                                    >
                                      Remove
                                    </button>
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
