import { describe, expect, it } from "vitest";
import { constantTimeEqual, decideGate, gateCookieValue } from "./gate";

const APP_KEY = "fixture-key-blimflar";

describe("gateCookieValue", () => {
  it("digests the key rather than storing it", async () => {
    const value = await gateCookieValue("abc");
    // SHA-256("abc"), pinned so the cookie format cannot drift silently — a drift would
    // lock every device out at once.
    expect(value).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("changes completely when the key rotates", async () => {
    expect(await gateCookieValue("key-one")).not.toBe(
      await gateCookieValue("key-two"),
    );
  });
});

describe("constantTimeEqual", () => {
  it("agrees with === on equal, unequal, and different-length strings", () => {
    expect(constantTimeEqual("abcd", "abcd")).toBe(true);
    expect(constantTimeEqual("abcd", "abce")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("decideGate", () => {
  it("stays out of the way when no key is configured", async () => {
    for (const appKey of [undefined, ""]) {
      expect(
        await decideGate({ appKey, cookieValue: undefined, pathname: "/" }),
      ).toBe("allow");
    }
  });

  it("renews a device with the digest cookie everywhere", async () => {
    const cookieValue = await gateCookieValue(APP_KEY);
    for (const pathname of ["/", "/list", "/settings", "/api/words"]) {
      expect(
        await decideGate({ appKey: APP_KEY, cookieValue, pathname }),
      ).toBe("renew");
    }
  });

  it("never renews on the open paths, where a wrong cookie also passes", async () => {
    const cookieValue = await gateCookieValue(APP_KEY);
    for (const pathname of ["/gate", "/api/gate"]) {
      expect(
        await decideGate({ appKey: APP_KEY, cookieValue, pathname }),
      ).toBe("allow");
      expect(
        await decideGate({ appKey: APP_KEY, cookieValue: "wrong", pathname }),
      ).toBe("allow");
    }
  });

  it("challenges pages and refuses the API without the cookie", async () => {
    expect(
      await decideGate({
        appKey: APP_KEY,
        cookieValue: undefined,
        pathname: "/",
      }),
    ).toBe("challenge");
    expect(
      await decideGate({
        appKey: APP_KEY,
        cookieValue: "wrong",
        pathname: "/list",
      }),
    ).toBe("challenge");
    expect(
      await decideGate({
        appKey: APP_KEY,
        cookieValue: undefined,
        pathname: "/api/words",
      }),
    ).toBe("unauthorized");
  });

  it("rejects the raw key pasted in as the cookie", async () => {
    expect(
      await decideGate({
        appKey: APP_KEY,
        cookieValue: APP_KEY,
        pathname: "/",
      }),
    ).toBe("challenge");
  });

  it("keeps the gate and its unlock handler reachable", async () => {
    for (const pathname of ["/gate", "/api/gate"]) {
      expect(
        await decideGate({ appKey: APP_KEY, cookieValue: undefined, pathname }),
      ).toBe("allow");
    }
  });
});
