/**
 * Per-ticket telemetry capture — independent of eventLogs.
 *
 * This solves Decision 1 Option B: eventLogs has no ticketId column,
 * so we track per-ticket timing separately via this module.
 *
 * The TelemetryTracker is an in-memory store that captures start/end
 * times, outcome, model, and payload sizes for each ticket in a
 * simulation run. It can be serialized alongside the JSONL results.
 */

import type { SuggestedModel, TicketTelemetry } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class TelemetryTracker {
  private entries = new Map<string, MutableTelemetry>();

  /**
   * Start tracking a ticket. Call this when the dev loop begins work on a ticket.
   */
  startTicket(corpusId: string, model: SuggestedModel, ticketId?: string): void {
    this.entries.set(corpusId, {
      corpusId,
      ticketId: ticketId ?? null,
      model,
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
      outcome: "resolved", // will be overwritten on completion
      payloadCharsIn: 0,
      payloadCharsOut: 0,
    });
  }

  /**
   * Record payload bytes for an in-progress ticket.
   */
  addPayload(corpusId: string, charsIn: number, charsOut: number): void {
    const entry = this.entries.get(corpusId);
    if (!entry) return;
    entry.payloadCharsIn += charsIn;
    entry.payloadCharsOut += charsOut;
  }

  /**
   * Associate a DB ticketId with a corpus entry (once the ticket is created in the DB).
   */
  setTicketId(corpusId: string, ticketId: string): void {
    const entry = this.entries.get(corpusId);
    if (entry) entry.ticketId = ticketId;
  }

  /**
   * Complete tracking for a ticket.
   */
  completeTicket(
    corpusId: string,
    outcome: TicketTelemetry["outcome"],
    escalatedTo?: SuggestedModel,
  ): void {
    const entry = this.entries.get(corpusId);
    if (!entry) return;

    const now = new Date();
    entry.completedAt = now.toISOString();
    entry.durationMs = now.getTime() - new Date(entry.startedAt).getTime();
    entry.outcome = outcome;
    if (escalatedTo) {
      entry.escalatedTo = escalatedTo;
    }
  }

  /**
   * Get telemetry for a specific ticket.
   */
  get(corpusId: string): TicketTelemetry | undefined {
    return this.entries.get(corpusId);
  }

  /**
   * Get all completed telemetry entries.
   */
  getCompleted(): TicketTelemetry[] {
    return [...this.entries.values()].filter((e) => e.completedAt !== null);
  }

  /**
   * Get all entries (including in-progress).
   */
  getAll(): TicketTelemetry[] {
    return [...this.entries.values()];
  }

  /**
   * Aggregate statistics from completed entries.
   */
  summarize(): TelemetrySummary {
    const completed = this.getCompleted();
    if (completed.length === 0) {
      return {
        totalTickets: 0,
        resolved: 0,
        failed: 0,
        timeout: 0,
        escalated: 0,
        avgDurationMs: 0,
        avgPayloadCharsIn: 0,
        avgPayloadCharsOut: 0,
        haikuCount: 0,
        sonnetCount: 0,
        haikuSuccessRate: 0,
        sonnetSuccessRate: 0,
      };
    }

    const resolved = completed.filter((e) => e.outcome === "resolved");
    const failed = completed.filter((e) => e.outcome === "failed");
    const timeout = completed.filter((e) => e.outcome === "timeout");
    const escalated = completed.filter((e) => e.outcome === "escalated");

    const haiku = completed.filter((e) => e.model === "haiku");
    const sonnet = completed.filter((e) => e.model === "sonnet");
    const haikuResolved = haiku.filter((e) => e.outcome === "resolved");
    const sonnetResolved = sonnet.filter((e) => e.outcome === "resolved");

    const totalDuration = completed.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
    const totalIn = completed.reduce((sum, e) => sum + e.payloadCharsIn, 0);
    const totalOut = completed.reduce((sum, e) => sum + e.payloadCharsOut, 0);

    return {
      totalTickets: completed.length,
      resolved: resolved.length,
      failed: failed.length,
      timeout: timeout.length,
      escalated: escalated.length,
      avgDurationMs: Math.round(totalDuration / completed.length),
      avgPayloadCharsIn: Math.round(totalIn / completed.length),
      avgPayloadCharsOut: Math.round(totalOut / completed.length),
      haikuCount: haiku.length,
      sonnetCount: sonnet.length,
      haikuSuccessRate: haiku.length > 0 ? haikuResolved.length / haiku.length : 0,
      sonnetSuccessRate: sonnet.length > 0 ? sonnetResolved.length / sonnet.length : 0,
    };
  }

  /**
   * Reset all entries (for a new run).
   */
  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MutableTelemetry = TicketTelemetry;

export interface TelemetrySummary {
  totalTickets: number;
  resolved: number;
  failed: number;
  timeout: number;
  escalated: number;
  avgDurationMs: number;
  avgPayloadCharsIn: number;
  avgPayloadCharsOut: number;
  haikuCount: number;
  sonnetCount: number;
  haikuSuccessRate: number;
  sonnetSuccessRate: number;
}
