import type { CrossInstanceCapability, CrossInstanceConfig, CrossInstancePeer } from "../core/config.js";
import {
  verifyCrossInstanceRequest,
  type CrossInstanceRequestSignatureInput,
  type CrossInstanceVerificationFailureReason,
} from "./cross-instance-auth.js";
import { CrossInstanceNonceStore } from "./cross-instance-nonce-store.js";
import { authorizeCrossInstanceTool } from "./cross-instance-policy.js";

export interface CrossInstanceHeaderBag {
  [key: string]: string | string[] | undefined;
}

type CrossInstanceRequestPeer = Pick<
  CrossInstancePeer,
  "instanceId" | "baseUrl" | "enabled" | "sharedSecret" | "nextSharedSecret"
> & {
  allowedCapabilities: readonly CrossInstanceCapability[];
};

export interface ValidateCrossInstanceRequestOptions {
  crossInstance: Omit<Pick<CrossInstanceConfig, "peers" | "timestampSkewSeconds">, "peers"> & {
    peers: readonly CrossInstanceRequestPeer[];
  };
  nonceStore: CrossInstanceNonceStore;
  tool: string;
  method: string;
  path: string;
  query?: CrossInstanceRequestSignatureInput["query"];
  body?: CrossInstanceRequestSignatureInput["body"];
  headers: CrossInstanceHeaderBag;
  now?: Date;
}

export type CrossInstanceRequestGuardFailureReason =
  | "missing_headers"
  | "unknown_peer"
  | "peer_disabled"
  | CrossInstanceVerificationFailureReason
  | "replayed_nonce"
  | "capability_not_allowed";

export type CrossInstanceRequestGuardResult =
  | {
    ok: true;
    peer: CrossInstanceRequestPeer;
    instanceId: string;
    matchedSecret: "current" | "next";
    bodyHash: string;
    canonicalRequest: string;
  }
  | {
    ok: false;
    reason: CrossInstanceRequestGuardFailureReason;
  };

export function validateCrossInstanceRequest(
  options: ValidateCrossInstanceRequestOptions,
): CrossInstanceRequestGuardResult {
  const instanceId = getHeader(options.headers, "x-agora-instance-id");
  const timestamp = getHeader(options.headers, "x-agora-timestamp");
  const nonce = getHeader(options.headers, "x-agora-nonce");
  const signature = getHeader(options.headers, "x-agora-signature");

  if (!instanceId || !timestamp || !nonce || !signature) {
    return { ok: false, reason: "missing_headers" };
  }

  const peer = options.crossInstance.peers.find((candidate) => candidate.instanceId === instanceId);
  if (!peer) {
    return { ok: false, reason: "unknown_peer" };
  }
  if (!peer.enabled) {
    return { ok: false, reason: "peer_disabled" };
  }

  const verified = verifyCrossInstanceRequest({
    method: options.method,
    path: options.path,
    query: options.query,
    body: options.body,
    timestamp,
    nonce,
    instanceId,
    signature,
    secret: peer.sharedSecret,
    nextSecret: peer.nextSharedSecret,
    now: options.now,
    timestampSkewSeconds: options.crossInstance.timestampSkewSeconds,
  });
  if (!verified.ok) {
    return verified;
  }

  const nonceDecision = options.nonceStore.checkAndStore(instanceId, nonce, (options.now ?? new Date()).getTime());
  if (!nonceDecision.accepted) {
    return { ok: false, reason: "replayed_nonce" };
  }

  const access = authorizeCrossInstanceTool(peer, options.tool);
  if (!access.allowed) {
    return { ok: false, reason: "capability_not_allowed" };
  }

  return {
    ok: true,
    peer,
    instanceId,
    matchedSecret: verified.matchedSecret,
    bodyHash: verified.bodyHash,
    canonicalRequest: verified.canonicalRequest,
  };
}

function getHeader(headers: CrossInstanceHeaderBag, key: string): string | undefined {
  const value = headers[key];
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  if (typeof value === "string") return value.trim() || undefined;
  return undefined;
}
