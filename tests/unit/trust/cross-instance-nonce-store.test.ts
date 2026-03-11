import { describe, expect, it } from "vitest";
import { CrossInstanceNonceStore } from "../../../src/trust/cross-instance-nonce-store.js";

describe("CrossInstanceNonceStore", () => {
  it("accepts the first nonce and rejects a replay within TTL", () => {
    const now = 1_000;
    const store = new CrossInstanceNonceStore(5_000, () => now);

    expect(store.checkAndStore("agora-peer", "nonce-1")).toEqual({
      accepted: true,
      reason: "accepted",
    });
    expect(store.checkAndStore("agora-peer", "nonce-1")).toEqual({
      accepted: false,
      reason: "replayed",
    });
  });

  it("allows the same nonce again after expiration", () => {
    let now = 1_000;
    const store = new CrossInstanceNonceStore(5_000, () => now);

    store.checkAndStore("agora-peer", "nonce-1");
    now = 6_100;

    expect(store.checkAndStore("agora-peer", "nonce-1")).toEqual({
      accepted: true,
      reason: "accepted",
    });
  });

  it("tracks nonces per peer", () => {
    const store = new CrossInstanceNonceStore(5_000, () => 1_000);

    store.checkAndStore("peer-a", "same-nonce");
    expect(store.checkAndStore("peer-b", "same-nonce")).toEqual({
      accepted: true,
      reason: "accepted",
    });
  });

  it("purges expired entries and updates size", () => {
    let now = 1_000;
    const store = new CrossInstanceNonceStore(5_000, () => now);

    store.checkAndStore("peer-a", "nonce-1");
    store.checkAndStore("peer-a", "nonce-2");
    expect(store.size()).toBe(2);

    now = 7_000;
    store.purgeExpired();

    expect(store.size()).toBe(0);
    expect(store.has("peer-a", "nonce-1")).toBe(false);
  });
});
