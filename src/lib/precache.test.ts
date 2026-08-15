import { describe, expect, it } from "vitest";
import { isCacheableShellResponse } from "./precache";

describe("isCacheableShellResponse", () => {
  it("caches a plain successful document", () => {
    expect(isCacheableShellResponse({ redirected: false, status: 200 })).toBe(
      true,
    );
  });

  it("refuses a document that arrived through a redirect", () => {
    // The key gate answers a locked device's precache fetch with a redirect to /gate;
    // caching its body would serve the gate as the app shell in airplane mode.
    expect(isCacheableShellResponse({ redirected: true, status: 200 })).toBe(
      false,
    );
  });

  it("still refuses errors, as the Serwist default it replaces did", () => {
    expect(isCacheableShellResponse({ redirected: false, status: 404 })).toBe(
      false,
    );
    expect(isCacheableShellResponse({ redirected: false, status: 500 })).toBe(
      false,
    );
  });
});
