import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface AuditExportOptions {
  db: DB;
  format: "json" | "csv";
  agentId?: string;
  sessionId?: string;
  since?: string;
  until?: string;
  limit?: number;
}

interface AuditRow {
  eventId: string;
  agentId: string;
  sessionId: string;
  tool: string;
  timestamp: string;
  durationMs: number;
  status: string;
  repoId: string;
  commitScope: string;
  payloadSizeIn: number;
  payloadSizeOut: number;
  inputHash: string;
  outputHash: string;
  redactedSummary: string;
  errorCode: string | null;
  errorDetail: string | null;
  denialReason: string | null;
}

const CSV_HEADERS: (keyof AuditRow)[] = [
  "eventId", "agentId", "sessionId", "tool", "timestamp",
  "durationMs", "status", "repoId", "commitScope",
  "payloadSizeIn", "payloadSizeOut", "inputHash", "outputHash",
  "redactedSummary", "errorCode", "errorDetail", "denialReason",
];

function escapeCsvField(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function exportAuditTrail(opts: AuditExportOptions): { content: string; rows: number } {
  const limit = opts.limit ?? 10000;

  let events: typeof queries.getEventLogs extends (db: DB, limit?: number) => infer R ? R : never;
  if (opts.agentId) {
    events = queries.getEventLogsByAgent(opts.db, opts.agentId, limit);
  } else if (opts.sessionId) {
    events = queries.getEventLogsBySession(opts.db, opts.sessionId, limit);
  } else {
    events = queries.getEventLogs(opts.db, limit);
  }

  // Apply date filters
  let filtered = events;
  if (opts.since) {
    filtered = filtered.filter((e) => e.timestamp >= opts.since!);
  }
  if (opts.until) {
    filtered = filtered.filter((e) => e.timestamp <= opts.until!);
  }

  const rows: AuditRow[] = filtered.map((e) => ({
    eventId: e.eventId,
    agentId: e.agentId,
    sessionId: e.sessionId,
    tool: e.tool,
    timestamp: e.timestamp,
    durationMs: e.durationMs,
    status: e.status,
    repoId: e.repoId,
    commitScope: e.commitScope,
    payloadSizeIn: e.payloadSizeIn,
    payloadSizeOut: e.payloadSizeOut,
    inputHash: e.inputHash,
    outputHash: e.outputHash,
    redactedSummary: e.redactedSummary,
    errorCode: e.errorCode,
    errorDetail: e.errorDetail,
    denialReason: e.denialReason,
  }));

  if (opts.format === "csv") {
    const header = CSV_HEADERS.join(",");
    const lines = rows.map((row) =>
      CSV_HEADERS.map((h) => escapeCsvField(row[h])).join(","),
    );
    return { content: [header, ...lines].join("\n"), rows: rows.length };
  }

  // JSON: NDJSON format for streaming compatibility
  const content = JSON.stringify({
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    rowCount: rows.length,
    filters: {
      agentId: opts.agentId ?? null,
      sessionId: opts.sessionId ?? null,
      since: opts.since ?? null,
      until: opts.until ?? null,
    },
    events: rows,
  }, null, 2);

  return { content, rows: rows.length };
}
