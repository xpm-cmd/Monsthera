import { describe, expect, it } from "vitest";
import {
  canonicalizeCrossInstanceRequest,
  isTimestampWithinSkew,
  signCrossInstanceRequest,
  verifyCrossInstanceRequest,
} from "../../../src/trust/cross-instance-auth.js";

describe("cross-instance auth helpers", () => {
  const baseInput = {
    method: "post",
    path: "/mcp",
    query: { tool: "status", verbose: true },
    timestamp: "2026-03-11T12:00:00.000Z",
    nonce: "nonce-123",
    instanceId: "agora-main",
    body: JSON.stringify({ hello: "world" }),
  };

  it("canonicalizes requests deterministically", () => {
    const canonical = canonicalizeCrossInstanceRequest({
      ...baseInput,
      query: "verbose=true&tool=status",
    });

    expect(canonical).toContain("POST\n/mcp\ntool=status&verbose=true\n2026-03-11T12:00:00.000Z\nnonce-123");
  });

  it("signs and verifies a request with the current secret", () => {
    const signed = signCrossInstanceRequest(baseInput, "1234567890abcdef");
    const verified = verifyCrossInstanceRequest({
      ...baseInput,
      signature: signed.signature,
      secret: "1234567890abcdef",
      now: new Date("2026-03-11T12:01:00.000Z"),
    });

    expect(verified).toEqual({
      ok: true,
      matchedSecret: "current",
      bodyHash: signed.bodyHash,
      canonicalRequest: signed.canonicalRequest,
    });
  });

  it("accepts the next secret during rotation", () => {
    const signed = signCrossInstanceRequest(baseInput, "fedcba0987654321");
    const verified = verifyCrossInstanceRequest({
      ...baseInput,
      signature: signed.signature,
      secret: "1234567890abcdef",
      nextSecret: "fedcba0987654321",
      now: new Date("2026-03-11T12:00:30.000Z"),
    });

    expect(verified).toEqual({
      ok: true,
      matchedSecret: "next",
      bodyHash: signed.bodyHash,
      canonicalRequest: signed.canonicalRequest,
    });
  });

  it("rejects invalid signature formats", () => {
    expect(verifyCrossInstanceRequest({
      ...baseInput,
      signature: "bad-format",
      secret: "1234567890abcdef",
      now: new Date("2026-03-11T12:00:30.000Z"),
    })).toEqual({
      ok: false,
      reason: "invalid_signature_format",
    });
  });

  it("rejects timestamps outside the allowed skew", () => {
    const signed = signCrossInstanceRequest(baseInput, "1234567890abcdef");
    expect(verifyCrossInstanceRequest({
      ...baseInput,
      signature: signed.signature,
      secret: "1234567890abcdef",
      now: new Date("2026-03-11T12:03:30.000Z"),
      timestampSkewSeconds: 120,
    })).toEqual({
      ok: false,
      reason: "timestamp_skew",
    });
  });

  it("rejects signatures generated with the wrong secret", () => {
    const signed = signCrossInstanceRequest(baseInput, "1234567890abcdef");
    expect(verifyCrossInstanceRequest({
      ...baseInput,
      signature: signed.signature,
      secret: "fedcba0987654321",
      now: new Date("2026-03-11T12:00:30.000Z"),
    })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("validates timestamp skew as a standalone helper", () => {
    expect(isTimestampWithinSkew(
      "2026-03-11T12:00:00.000Z",
      new Date("2026-03-11T12:01:30.000Z"),
      120,
    )).toBe(true);

    expect(isTimestampWithinSkew(
      "not-a-date",
      new Date("2026-03-11T12:01:30.000Z"),
      120,
    )).toBe(false);
  });
});
