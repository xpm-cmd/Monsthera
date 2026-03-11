import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface CrossInstanceRequestSignatureInput {
  method: string;
  path: string;
  query?: string | URLSearchParams | Record<string, string | number | boolean | Array<string | number | boolean>>;
  timestamp: string;
  nonce: string;
  instanceId: string;
  body?: string | Uint8Array | null;
}

export interface VerifyCrossInstanceRequestOptions extends CrossInstanceRequestSignatureInput {
  signature: string;
  secret: string;
  nextSecret?: string;
  now?: Date;
  timestampSkewSeconds?: number;
}

export type CrossInstanceVerificationFailureReason =
  | "invalid_signature_format"
  | "invalid_timestamp"
  | "timestamp_skew"
  | "signature_mismatch";

export type CrossInstanceVerificationResult =
  | { ok: true; matchedSecret: "current" | "next"; bodyHash: string; canonicalRequest: string }
  | { ok: false; reason: CrossInstanceVerificationFailureReason };

const SIGNATURE_PREFIX = "v1=";

export function signCrossInstanceRequest(
  input: CrossInstanceRequestSignatureInput,
  secret: string,
): { signature: string; bodyHash: string; canonicalRequest: string } {
  const bodyHash = sha256Hex(normalizeBody(input.body));
  const canonicalRequest = canonicalizeCrossInstanceRequest(input, bodyHash);
  const signature = SIGNATURE_PREFIX + createHmac("sha256", secret).update(canonicalRequest).digest("hex");
  return { signature, bodyHash, canonicalRequest };
}

export function verifyCrossInstanceRequest(
  options: VerifyCrossInstanceRequestOptions,
): CrossInstanceVerificationResult {
  if (!options.signature.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: "invalid_signature_format" };
  }

  if (!isTimestampWithinSkew(
    options.timestamp,
    options.now ?? new Date(),
    options.timestampSkewSeconds ?? 120,
  )) {
    const parsed = Date.parse(options.timestamp);
    return { ok: false, reason: Number.isFinite(parsed) ? "timestamp_skew" : "invalid_timestamp" };
  }

  const current = signCrossInstanceRequest(options, options.secret);
  if (constantTimeEquals(options.signature, current.signature)) {
    return { ok: true, matchedSecret: "current", bodyHash: current.bodyHash, canonicalRequest: current.canonicalRequest };
  }

  if (options.nextSecret) {
    const next = signCrossInstanceRequest(options, options.nextSecret);
    if (constantTimeEquals(options.signature, next.signature)) {
      return { ok: true, matchedSecret: "next", bodyHash: next.bodyHash, canonicalRequest: next.canonicalRequest };
    }
  }

  return { ok: false, reason: "signature_mismatch" };
}

export function canonicalizeCrossInstanceRequest(
  input: CrossInstanceRequestSignatureInput,
  bodyHash = sha256Hex(normalizeBody(input.body)),
): string {
  return [
    input.method.trim().toUpperCase(),
    normalizePath(input.path),
    normalizeQuery(input.query),
    input.timestamp.trim(),
    input.nonce.trim(),
    bodyHash,
    input.instanceId.trim(),
  ].join("\n");
}

export function isTimestampWithinSkew(
  timestamp: string,
  now: Date,
  skewSeconds: number,
): boolean {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(now.getTime() - parsed) <= skewSeconds * 1000;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeQuery(
  query: CrossInstanceRequestSignatureInput["query"],
): string {
  const pairs: Array<[string, string]> = [];

  if (typeof query === "string") {
    const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
    params.forEach((value, key) => pairs.push([key, value]));
  }
  else if (query instanceof URLSearchParams) {
    query.forEach((value, key) => pairs.push([key, value]));
  }
  else if (query) {
    for (const [key, raw] of Object.entries(query)) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        pairs.push([key, String(value)]);
      }
    }
  }

  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
    return leftKey.localeCompare(rightKey);
  });

  return pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function normalizeBody(body: CrossInstanceRequestSignatureInput["body"]): Uint8Array {
  if (body == null) return new Uint8Array();
  if (typeof body === "string") return Buffer.from(body);
  return body;
}

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
