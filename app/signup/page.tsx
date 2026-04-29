"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invite = searchParams?.get("invite") ?? null;
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const trimmed = displayName.trim();
      if (trimmed.length < 1) throw new Error("Display name required");

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { display_name: trimmed } },
      });
      if (signUpError) throw signUpError;
      if (!data.user) throw new Error("Signup did not return a user");

      const { error: profileError } = await supabase
        .from("profiles")
        .insert({ id: data.user.id, display_name: trimmed });
      if (profileError) throw profileError;

      router.replace(invite ? `/join/${encodeURIComponent(invite)}` : "/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-6 px-6 py-12">
      <h1 className="text-2xl font-semibold">Create account</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Display name
          <input
            className="rounded border border-gray-300 px-3 py-2 text-base"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            required
          />
        </label>
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
            autoComplete="new-password"
            minLength={6}
            required
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Sign up"}
        </button>
      </form>
      <p className="text-sm text-gray-600">
        Already have an account?{" "}
        <Link
          className="text-red-600 underline"
          href={invite ? `/login?invite=${encodeURIComponent(invite)}` : "/login"}
        >
          Log in
        </Link>
      </p>
    </main>
  );
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex min-h-full w-full max-w-sm items-center justify-center px-6 py-12 text-sm text-gray-500">
          Loading…
        </main>
      }
    >
      <SignupForm />
    </Suspense>
  );
}
