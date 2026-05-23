import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedPushRequest } from "./route";

function req(headers: HeadersInit = {}) {
  return { headers: new Headers(headers) };
}

describe("isAuthorizedPushRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows local development without a configured secret", () => {
    vi.stubEnv("PUSH_NOTIFY_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(isAuthorizedPushRequest(req())).toBe(true);
  });

  it("rejects production requests when no secret is configured", () => {
    vi.stubEnv("PUSH_NOTIFY_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(isAuthorizedPushRequest(req())).toBe(false);
  });

  it("accepts the shared secret header or bearer token", () => {
    vi.stubEnv("PUSH_NOTIFY_SECRET", "secret-123");
    vi.stubEnv("NODE_ENV", "production");
    expect(isAuthorizedPushRequest(req({ "x-push-secret": "secret-123" }))).toBe(
      true
    );
    expect(
      isAuthorizedPushRequest(req({ authorization: "Bearer secret-123" }))
    ).toBe(true);
  });

  it("rejects missing or incorrect secrets", () => {
    vi.stubEnv("PUSH_NOTIFY_SECRET", "secret-123");
    vi.stubEnv("NODE_ENV", "production");
    expect(isAuthorizedPushRequest(req())).toBe(false);
    expect(isAuthorizedPushRequest(req({ "x-push-secret": "wrong" }))).toBe(
      false
    );
  });
});
