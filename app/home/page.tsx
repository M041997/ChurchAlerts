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

export default function HomePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newChurchName, setNewChurchName] = useState("");
  const [mintedInvite, setMintedInvite] = useState<{
    churchId: string;
    url: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: prof } = await supabase
      .from("profiles")
      .select("id, display_name")
      .maybeSingle<Profile>();
    setProfile(prof ?? null);

    const { data: mems } = await supabase
      .from("church_members")
      .select("church_id, role, churches(id, name)")
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

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  async function handleCreateChurch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const trimmed = newChurchName.trim();
      if (!trimmed) throw new Error("Church name required");
      const { error: rpcErr } = await supabase.rpc("create_church", {
        church_name: trimmed,
      });
      if (rpcErr) throw rpcErr;
      setNewChurchName("");
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
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
            You&apos;re not in any church yet. Create one below or use an
            invite link.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {memberships.map((m) => (
              <li
                key={m.church_id}
                className="flex flex-col gap-2 rounded border border-gray-200 p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{m.churches?.name}</span>
                  <span className="text-xs uppercase text-gray-500">
                    {m.role === "owner" ? "admin" : m.role}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/c/${m.church_id}`}
                    className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white"
                  >
                    Open chat
                  </Link>
                  {m.role === "owner" && (
                    <button
                      onClick={() => handleMintInvite(m.church_id)}
                      className="rounded border border-gray-300 px-3 py-1 text-sm"
                    >
                      Mint invite link
                    </button>
                  )}
                </div>
                {mintedInvite?.churchId === m.church_id && (
                  <div className="flex flex-col gap-1 rounded bg-gray-100 p-2 text-xs">
                    <span className="text-gray-500">Single-use link:</span>
                    <code className="break-all">{mintedInvite.url}</code>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 border-t border-gray-200 pt-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500">
          Create a new church
        </h2>
        <form onSubmit={handleCreateChurch} className="flex gap-2">
          <input
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-base"
            placeholder="Church name"
            value={newChurchName}
            onChange={(e) => setNewChurchName(e.target.value)}
            required
          />
          <button
            type="submit"
            disabled={creating}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </form>
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
