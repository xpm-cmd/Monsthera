import { describe, expect, it } from "vitest";
import { CrossInstanceNonceStore } from "../../../src/trust/cross-instance-nonce-store.js";
import { signCrossInstanceRequest } from "../../../src/trust/cross-instance-auth.js";
import { validateCrossInstanceRequest } from "../../../src/trust/cross-instance-request-guard.js";

describe("validateCrossInstanceRequest", () => {
  const peer = {
    instanceId: "monsthera-peer",
    baseUrl: "https://peer.example.test",
    enabled: true,
    sharedSecret: "1234567890abcdef",
    allowedCapabilities: ["read_code"] as const,
  };

  const baseInput = {
    method: "POST",
    path: "/mcp",
    query: { tool: "status" },
    timestamp: "2026-03-11T12:00:00.000Z",
    nonce: "nonce-123",
    instanceId: "monsthera-peer",
    body: JSON.stringify({ tool: "status" }),
  };

  function signedHeaders(secret = peer.sharedSecret) {
    const signed = signCrossInstanceRequest(baseInput, secret);
    return {
      "x-monsthera-instance-id": baseInput.instanceId,
      "x-monsthera-timestamp": baseInput.timestamp,
      "x-monsthera-nonce": baseInput.nonce,
      "x-monsthera-signature": signed.signature,
    };
  }

  it("accepts a valid request for an allowed tool", () => {
    const nonceStore = new CrossInstanceNonceStore(10_000, () => Date.parse("2026-03-11T12:00:30.000Z"));
    const result = validateCrossInstanceRequest({
      crossInstance: { peers: [peer], timestampSkewSeconds: 120 },
      nonceStore,
      tool: "get_code_pack",
      method: baseInput.method,
      path: baseInput.path,
      query: baseInput.query,
      body: baseInput.body,
      headers: signedHeaders(),
      now: new Date("2026-03-11T12:00:30.000Z"),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peer.instanceId).toBe("monsthera-peer");
      expect(result.matchedSecret).toBe("current");
    }
  });

  it("rejects requests with missing auth headers", () => {
    const nonceStore = new CrossInstanceNonceStore(10_000, () => Date.parse("2026-03-11T12:00:30.000Z"));
    expect(validateCrossInstanceRequest({
      crossInstance: { peers: [peer], timestampSkewSeconds: 120 },
      nonceStore,
      tool: "get_code_pack",
      method: baseInput.method,
      path: baseInput.path,
      headers: {},
      now: new Date("2026-03-11T12:00:30.000Z"),
    })).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });

  it("rejects unknown peers before signature verification", () => {
    const nonceStore = new CrossInstanceNonceStore(10_000, () => Date.parse("2026-03-11T12:00:30.000Z"));
    const headers = signedHeaders();
    headers["x-monsthera-instance-id"] = "unknown-peer";

    expect(validateCrossInstanceRequest({
      crossInstance: { peers: [peer], timestampSkewSeconds: 120 },
      nonceStore,
      tool: "get_code_pack",
      method: baseInput.method,
      path: baseInput.path,
      query: baseInput.query,
      body: baseInput.body,
      headers,
      now: new Date("2026-03-11T12:00:30.000Z"),
    })).toEqual({
      ok: false,
      reason: "unknown_peer",
    });
  });

  it("rejects replayed nonces", () => {
    const now = new Date("2026-03-11T12:00:30.000Z");
    const nonceStore = new CrossInstanceNonceStore(10_000, () => now.getTime());

    const first = validateCrossInstanceRequest({
      crossInstance: { peers: [peer], timestampSkewSeconds: 120 },
      nonceStore,
      tool: "get_code_pack",
      method: baseInput.method,
      path: baseInput.path,
      query: baseInput.query,
      body: baseInput.body,
      headers: signedHeaders(),
      now,
    });
    expect(first.ok).toBe(true);

    expect(validateCrossInstanceRequest({
      crossInstance: { peers: [peer], timestampSkewSeconds: 120 },
      nonceStore,
      tool: "get_code_pack",
      method: baseInput.method,
      path: baseInput.path,
      query: baseInput.query,
      body: baseInput.body,
      headers: signedHeaders(),
      now,
    })).toEqual({
      ok: false,
      reason: "replayed_nonce",
    });
  });

  it("rejects tools outside the peer capability policy", () => {
    const nonceStore = new CrossInstanceNonceStore(10_000, () => Date.parse("2026-03-11T12:00:30.000Z"));
    expect(validateCrossInstanceRequest({
      crossInstance: { peers: [peer], timestampSkewSeconds: 120 },
      nonceStore,
      tool: "search_knowledge",
      method: baseInput.method,
      path: baseInput.path,
      query: baseInput.query,
      body: baseInput.body,
      headers: signedHeaders(),
      now: new Date("2026-03-11T12:00:30.000Z"),
    })).toEqual({
      ok: false,
      reason: "capability_not_allowed",
    });
  });
});
