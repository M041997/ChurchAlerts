import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");

describe("schema security guardrails", () => {
  it("does not recreate the direct self-update membership policy", () => {
    expect(schema).toContain('drop policy if exists "members_self_update"');
    expect(schema).not.toContain('create policy "members_self_update"');
  });

  it("updates joined teams through a security-definer RPC", () => {
    expect(schema).toContain("create or replace function public.update_joined_teams");
    expect(schema).toContain("security definer");
    expect(schema).toContain("join public.church_teams");
    expect(schema).toContain("grant execute on function public.update_joined_teams");
  });

  it("does not expose every invite row for anonymous preview", () => {
    expect(schema).toContain('drop policy if exists "invites_token_preview"');
    expect(schema).not.toContain('create policy "invites_token_preview"');
    expect(schema).toContain("create or replace function public.preview_invite");
    expect(schema).toContain(
      "grant execute on function public.preview_invite(text) to anon, authenticated"
    );
  });
});
