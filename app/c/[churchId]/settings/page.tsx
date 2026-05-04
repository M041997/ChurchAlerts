"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  supabase,
  slugify,
  type Team,
  type Location,
} from "@/lib/supabase";
import { errorMessage } from "@/lib/utils";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; churchName: string }
  | { kind: "error"; message: string };

export default function ChurchSettingsPage() {
  const router = useRouter();
  const params = useParams<{ churchId: string }>();
  const churchId = params?.churchId ?? "";
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [teams, setTeams] = useState<Team[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [newTeamName, setNewTeamName] = useState("");
  const [newLocName, setNewLocName] = useState("");
  const [newLocLat, setNewLocLat] = useState("");
  const [newLocLng, setNewLocLng] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [{ data: teamRows }, { data: locRows }] = await Promise.all([
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
    setTeams(teamRows ?? []);
    setLocations(locRows ?? []);
  }, [churchId]);

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

      const [{ data: church }, { data: membership }] = await Promise.all([
        supabase
          .from("churches")
          .select("id, name")
          .eq("id", churchId)
          .maybeSingle<{ id: string; name: string }>(),
        supabase
          .from("church_members")
          .select("role")
          .eq("user_id", userData.user.id)
          .eq("church_id", churchId)
          .maybeSingle<{ role: "owner" | "member" }>(),
      ]);
      if (cancelled) return;

      if (!church) {
        setState({ kind: "error", message: "Church not found" });
        return;
      }
      if (!membership || membership.role !== "owner") {
        setState({
          kind: "error",
          message: "Admins only — open the chat for this church.",
        });
        return;
      }
      await reload();
      if (!cancelled) setState({ kind: "ready", churchName: church.name });
    })();
    return () => {
      cancelled = true;
    };
  }, [churchId, router, reload]);

  async function handleAddTeam(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const name = newTeamName.trim();
    if (!name) return;
    const slug = slugify(name);
    if (!slug) {
      setError("Name has no usable letters/digits.");
      return;
    }
    setBusy(`add-team`);
    const nextOrder =
      (teams.reduce((m, t) => Math.max(m, t.sort_order ?? 0), 0) || 0) + 10;
    const { error: err } = await supabase.from("church_teams").insert({
      church_id: churchId,
      slug,
      name,
      sort_order: nextOrder,
    });
    setBusy(null);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    setNewTeamName("");
    await reload();
  }

  async function handleRenameTeam(slug: string, name: string) {
    setBusy(`team-${slug}`);
    const { error: err } = await supabase
      .from("church_teams")
      .update({ name })
      .eq("church_id", churchId)
      .eq("slug", slug);
    setBusy(null);
    if (err) {
      setError(errorMessage(err));
      return;
    }
  }

  async function handleDeleteTeam(slug: string, name: string) {
    if (
      !window.confirm(
        `Remove team "${name}"? Old messages tagged with this team will keep the slug but render unstyled.`
      )
    )
      return;
    setBusy(`team-${slug}`);
    const { error: err } = await supabase
      .from("church_teams")
      .delete()
      .eq("church_id", churchId)
      .eq("slug", slug);
    setBusy(null);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    await reload();
  }

  async function handleAddLocation(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const name = newLocName.trim();
    if (!name) return;
    const slug = slugify(name);
    if (!slug) {
      setError("Name has no usable letters/digits.");
      return;
    }
    const lat = newLocLat.trim() ? Number(newLocLat) : null;
    const lng = newLocLng.trim() ? Number(newLocLng) : null;
    if (
      (lat !== null && Number.isNaN(lat)) ||
      (lng !== null && Number.isNaN(lng))
    ) {
      setError("Latitude and longitude must be numbers.");
      return;
    }
    setBusy("add-loc");
    const nextOrder =
      (locations.reduce((m, l) => Math.max(m, l.sort_order ?? 0), 0) || 0) + 10;
    const { error: err } = await supabase.from("church_locations").insert({
      church_id: churchId,
      slug,
      name,
      latitude: lat,
      longitude: lng,
      sort_order: nextOrder,
    });
    setBusy(null);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    setNewLocName("");
    setNewLocLat("");
    setNewLocLng("");
    await reload();
  }

  async function handleSaveLocation(loc: Location) {
    setBusy(`loc-${loc.slug}`);
    const { error: err } = await supabase
      .from("church_locations")
      .update({
        name: loc.name,
        latitude: loc.latitude,
        longitude: loc.longitude,
      })
      .eq("church_id", churchId)
      .eq("slug", loc.slug);
    setBusy(null);
    if (err) {
      setError(errorMessage(err));
      return;
    }
  }

  async function handleDeleteLocation(slug: string, name: string) {
    if (
      !window.confirm(
        `Remove location "${name}"? Old alerts tagged with it will keep the slug but lose the friendly name.`
      )
    )
      return;
    setBusy(`loc-${slug}`);
    const { error: err } = await supabase
      .from("church_locations")
      .delete()
      .eq("church_id", churchId)
      .eq("slug", slug);
    setBusy(null);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    await reload();
  }

  async function handleUseMyLocation(slug: string) {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    setBusy(`gps-${slug}`);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocations((prev) =>
          prev.map((l) =>
            l.slug === slug
              ? {
                  ...l,
                  latitude: pos.coords.latitude,
                  longitude: pos.coords.longitude,
                }
              : l
          )
        );
        setBusy(null);
      },
      () => {
        setBusy(null);
        setError("Couldn't read your GPS — check browser permissions.");
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  }

  if (state.kind === "loading") {
    return (
      <main className="flex min-h-full items-center justify-center bg-neutral-950 text-sm text-neutral-400">
        Loading…
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-3 bg-neutral-950 px-6 py-12 text-neutral-100">
        <h1 className="text-xl font-semibold">Church settings</h1>
        <p className="text-sm text-red-400">{state.message}</p>
        <Link className="text-sm text-red-400 underline" href="/home">
          Back to home
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 bg-neutral-950 px-4 py-6 text-neutral-100">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">{state.churchName}</h1>
          <p className="text-xs uppercase tracking-wide text-neutral-500">
            Settings · admin only
          </p>
        </div>
        <Link
          href={`/c/${churchId}`}
          className="text-sm text-red-400 underline"
        >
          ← Chat
        </Link>
      </header>

      {error && (
        <p className="rounded border border-red-700/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Teams
        </h2>
        <p className="text-xs text-neutral-500">
          Members can join any of these teams. The slug is locked once created
          so old messages keep rendering — only the display name is editable.
        </p>
        <ul className="flex flex-col gap-2">
          {teams.map((t) => (
            <li
              key={t.slug}
              className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-2"
            >
              <input
                value={t.name}
                onChange={(e) =>
                  setTeams((prev) =>
                    prev.map((x) =>
                      x.slug === t.slug ? { ...x, name: e.target.value } : x
                    )
                  )
                }
                onBlur={() => {
                  const cur = teams.find((x) => x.slug === t.slug);
                  if (cur && cur.name.trim()) handleRenameTeam(t.slug, cur.name.trim());
                }}
                className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
              />
              <span className="font-mono text-xs text-neutral-500">{t.slug}</span>
              <button
                type="button"
                onClick={() => handleDeleteTeam(t.slug, t.name)}
                disabled={busy === `team-${t.slug}`}
                className="rounded border border-red-700/50 px-2 py-1 text-xs text-red-300 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={handleAddTeam}
          className="flex gap-2 rounded border border-dashed border-neutral-700 px-3 py-2"
        >
          <input
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            placeholder="New team name (e.g. Tech Crew)"
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={busy === "add-team" || !newTeamName.trim()}
            className="rounded bg-emerald-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
          >
            Add team
          </button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Locations
        </h2>
        <p className="text-xs text-neutral-500">
          Used by the @-picker, GPS auto-tagging, and map links. Coords are
          optional — leave blank if you don&apos;t want auto-tag for that
          location.
        </p>
        <ul className="flex flex-col gap-2">
          {locations.map((l) => (
            <li
              key={l.slug}
              className="flex flex-col gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <input
                  value={l.name}
                  onChange={(e) =>
                    setLocations((prev) =>
                      prev.map((x) =>
                        x.slug === l.slug ? { ...x, name: e.target.value } : x
                      )
                    )
                  }
                  className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
                />
                <span className="font-mono text-xs text-neutral-500">
                  {l.slug}
                </span>
                <button
                  type="button"
                  onClick={() => handleDeleteLocation(l.slug, l.name)}
                  disabled={busy === `loc-${l.slug}`}
                  className="rounded border border-red-700/50 px-2 py-1 text-xs text-red-300 disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1">
                  Lat
                  <input
                    value={l.latitude ?? ""}
                    onChange={(e) =>
                      setLocations((prev) =>
                        prev.map((x) =>
                          x.slug === l.slug
                            ? {
                                ...x,
                                latitude:
                                  e.target.value === ""
                                    ? null
                                    : Number(e.target.value),
                              }
                            : x
                        )
                      )
                    }
                    inputMode="decimal"
                    className="w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 font-mono"
                  />
                </label>
                <label className="flex items-center gap-1">
                  Lng
                  <input
                    value={l.longitude ?? ""}
                    onChange={(e) =>
                      setLocations((prev) =>
                        prev.map((x) =>
                          x.slug === l.slug
                            ? {
                                ...x,
                                longitude:
                                  e.target.value === ""
                                    ? null
                                    : Number(e.target.value),
                              }
                            : x
                        )
                      )
                    }
                    inputMode="decimal"
                    className="w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 font-mono"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => handleUseMyLocation(l.slug)}
                  disabled={busy === `gps-${l.slug}`}
                  className="rounded border border-neutral-700 px-2 py-0.5 text-xs disabled:opacity-50"
                >
                  📍 Use my GPS
                </button>
                <button
                  type="button"
                  onClick={() => handleSaveLocation(l)}
                  disabled={busy === `loc-${l.slug}`}
                  className="ml-auto rounded bg-neutral-700 px-3 py-0.5 text-xs disabled:opacity-50"
                >
                  Save row
                </button>
              </div>
            </li>
          ))}
        </ul>
        <form
          onSubmit={handleAddLocation}
          className="flex flex-col gap-2 rounded border border-dashed border-neutral-700 px-3 py-2"
        >
          <input
            value={newLocName}
            onChange={(e) => setNewLocName(e.target.value)}
            placeholder="New location name (e.g. Side Entrance)"
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input
              value={newLocLat}
              onChange={(e) => setNewLocLat(e.target.value)}
              inputMode="decimal"
              placeholder="Lat (optional)"
              className="w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 font-mono"
            />
            <input
              value={newLocLng}
              onChange={(e) => setNewLocLng(e.target.value)}
              inputMode="decimal"
              placeholder="Lng (optional)"
              className="w-32 rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 font-mono"
            />
            <button
              type="submit"
              disabled={busy === "add-loc" || !newLocName.trim()}
              className="ml-auto rounded bg-emerald-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              Add location
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
