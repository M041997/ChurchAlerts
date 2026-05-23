"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type InviteRow = {
  token: string;
  church_id: string;
  redeemed_by: string | null;
  expires_at: string;
  church_name: string;
};
type ChurchRow = { id: string; name: string };
type State =
  | { kind: "loading" }
  | { kind: "preview"; church: ChurchRow }
  | { kind: "redeeming" }
  | { kind: "redeemed"; church: ChurchRow }
  | { kind: "error"; message: string };

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params?.token ?? "";
  const [state, setState] = useState<State>(() =>
    token
      ? { kind: "loading" }
      : { kind: "error", message: "Missing invite token" }
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    (async () => {
      const { data: previewsRaw, error: inviteErr } = await supabase.rpc(
        "preview_invite",
        { invite_token: token }
      );
      if (cancelled) return;
      const previews = previewsRaw as InviteRow[] | null;
      const invite = previews?.[0] ?? null;
      if (inviteErr || !invite) {
        setState({ kind: "error", message: "Invite not found" });
        return;
      }
      if (invite.redeemed_by) {
        setState({ kind: "error", message: "Invite already used" });
        return;
      }
      if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        setState({ kind: "error", message: "Invite expired" });
        return;
      }

      const church: ChurchRow = {
        id: invite.church_id,
        name: invite.church_name,
      };

      const { data: session } = await supabase.auth.getSession();
      if (cancelled) return;

      if (!session.session) {
        setState({ kind: "preview", church });
        return;
      }

      setState({ kind: "redeeming" });
      const { data: redeemedChurchId, error: redeemErr } = await supabase.rpc(
        "redeem_invite",
        { invite_token: token }
      );
      if (cancelled) return;
      if (redeemErr || !redeemedChurchId) {
        setState({
          kind: "error",
          message: redeemErr?.message ?? "Could not redeem invite",
        });
        return;
      }
      setState({ kind: "redeemed", church });
      setTimeout(() => {
        if (!cancelled) router.replace("/home");
      }, 1200);
    })();

    return () => {
      cancelled = true;
    };
  }, [token, router]);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-4 px-6 py-12">
      {state.kind === "loading" && (
        <p className="text-sm text-gray-500">Loading invite…</p>
      )}
      {state.kind === "error" && (
        <>
          <h1 className="text-xl font-semibold">Invite problem</h1>
          <p className="text-sm text-red-600">{state.message}</p>
          <Link className="text-sm text-red-600 underline" href="/login">
            Go to login
          </Link>
        </>
      )}
      {state.kind === "preview" && (
        <>
          <h1 className="text-xl font-semibold">
            Join {state.church.name}
          </h1>
          <p className="text-sm text-gray-600">
            Sign in or create an account to join this church.
          </p>
          <Link
            className="rounded bg-red-600 px-4 py-2 text-center font-medium text-white"
            href={`/signup?invite=${encodeURIComponent(token)}`}
          >
            Sign up
          </Link>
          <Link
            className="rounded border border-gray-300 px-4 py-2 text-center text-sm"
            href={`/login?invite=${encodeURIComponent(token)}`}
          >
            Log in
          </Link>
        </>
      )}
      {state.kind === "redeeming" && (
        <p className="text-sm text-gray-500">Joining…</p>
      )}
      {state.kind === "redeemed" && (
        <>
          <h1 className="text-xl font-semibold">Joined {state.church.name}</h1>
          <p className="text-sm text-gray-600">Redirecting…</p>
        </>
      )}
    </main>
  );
}
