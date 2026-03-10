import { createHash, randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import { compileSecretPatterns, redactSecrets } from "../trust/secret-patterns.js";
import type { SecretPatternRule } from "../core/config.js";
import { DEBUG_PAYLOAD_TTL_MS, REDACTED_SUMMARY_MAX_LENGTH } from "../core/constants.js";

export interface LogEventInput {
  agentId: string;
  sessionId: string;
  tool: string;
  repoId: string;
  commitScope: string;
  input: string;
  output: string;
  status: "success" | "error" | "denied" | "stale";
  durationMs: number;
  denialReason?: string;
}

export function logEvent(
  db: BetterSQLite3Database<typeof schema>,
  event: LogEventInput,
  debugLogging: boolean,
  secretPatterns: SecretPatternRule[] = [],
): string {
  const eventId = `evt-${randomUUID().slice(0, 12)}`;
  const inputHash = createHash("sha256").update(event.input).digest("hex");
  const outputHash = createHash("sha256").update(event.output).digest("hex");
  const patterns = compileSecretPatterns(secretPatterns);

  const summaryRaw = `${event.tool}: ${event.status}`;
  const redactedSummary = redactSecrets(summaryRaw, patterns).slice(0, REDACTED_SUMMARY_MAX_LENGTH);

  queries.insertEventLog(db, {
    eventId,
    agentId: event.agentId,
    sessionId: event.sessionId,
    tool: event.tool,
    timestamp: new Date().toISOString(),
    durationMs: event.durationMs,
    status: event.status,
    repoId: event.repoId,
    commitScope: event.commitScope,
    payloadSizeIn: event.input.length,
    payloadSizeOut: event.output.length,
    inputHash,
    outputHash,
    redactedSummary,
    denialReason: event.denialReason,
  });

  if (debugLogging) {
    const expiresAt = new Date(Date.now() + DEBUG_PAYLOAD_TTL_MS).toISOString();
    queries.insertDebugPayload(db, {
      eventId,
      rawInput: redactSecrets(event.input, patterns),
      rawOutput: redactSecrets(event.output, patterns),
      expiresAt,
    });
  }

  return eventId;
}

export function cleanupExpiredPayloads(
  db: BetterSQLite3Database<typeof schema>,
): void {
  queries.cleanExpiredPayloads(db);
}
