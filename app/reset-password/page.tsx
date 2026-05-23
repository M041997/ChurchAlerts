"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type Status = "checking" | "ready" | "no-session" | "saving" | "saved";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recoveredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    // Supabase parses the recovery token from the URL hash and emits
    // PASSWORD_RECOVERY automatically; if the user already has a session
    // (e.g. they reload after clicking the email), the existing session
    // is enough to call updateUser.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (cancelled) return;
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        recoveredRef.current = true;
        setStatus("ready");
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) {
        recoveredRef.current = true;
        setStatus("ready");
      } else {
        // Give the hash parser a moment to fire its event before declaring
        // the link dead.
        setTimeout(() => {
          if (!cancelled && !recoveredRef.current) setStatus("no-session");
        }, 1500);
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setStatus("saving");
    const { error: updateErr } = await supabase.auth.updateUser({ password });
    if (updateErr) {
      setError(updateErr.message);
      setStatus("ready");
      return;
    }
    setStatus("saved");
    setTimeout(() => router.replace("/home"), 1200);
  }

  if (status === "checking") {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-sm items-center justify-center px-6 py-12 text-sm text-gray-500">
        Validating reset link…
      </main>
    );
  }

  if (status === "no-session") {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-4 px-6 py-12">
        <h1 className="text-xl font-semibold">Reset link expired</h1>
        <p className="text-sm text-gray-600">
          That link is no longer valid. Request a new one and try again.
        </p>
        <Link className="text-sm text-red-600 underline" href="/forgot-password">
          Request a new reset link
        </Link>
      </main>
    );
  }

  if (status === "saved") {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-4 px-6 py-12">
        <h1 className="text-xl font-semibold">Password updated</h1>
        <p className="text-sm text-gray-600">Redirecting…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-6 px-6 py-12">
      <h1 className="text-2xl font-semibold">Set a new password</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          New password
          <input
            className="rounded border border-gray-300 px-3 py-2 text-base"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={6}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Confirm
          <input
            className="rounded border border-gray-300 px-3 py-2 text-base"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={6}
            required
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={status === "saving"}
          className="rounded bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {status === "saving" ? "Saving…" : "Save password"}
        </button>
      </form>
    </main>
  );
}
