"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { hasSupabaseConfig, supabase, supabaseConfigMessage } from "@/lib/supabase";
import { errorMessage } from "@/lib/utils";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invite = searchParams?.get("invite") ?? null;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!hasSupabaseConfig) {
      setError(supabaseConfigMessage);
      return;
    }
    setSubmitting(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;
      router.replace(invite ? `/join/${encodeURIComponent(invite)}` : "/home");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-6 px-6 py-12">
      <h1 className="text-2xl font-semibold">Log in</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            className="rounded border border-gray-300 px-3 py-2 text-base"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            className="rounded border border-gray-300 px-3 py-2 text-base"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!hasSupabaseConfig && (
          <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {supabaseConfigMessage}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || !hasSupabaseConfig}
          className="rounded bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Logging in…" : "Log in"}
        </button>
      </form>
      <p className="text-sm">
        <Link className="text-red-600 underline" href="/forgot-password">
          Forgot password?
        </Link>
      </p>
      <p className="text-sm text-gray-600">
        No account?{" "}
        <Link
          className="text-red-600 underline"
          href={invite ? `/signup?invite=${encodeURIComponent(invite)}` : "/signup"}
        >
          Sign up
        </Link>
      </p>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex min-h-full w-full max-w-sm items-center justify-center px-6 py-12 text-sm text-gray-500">
          Loading…
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
