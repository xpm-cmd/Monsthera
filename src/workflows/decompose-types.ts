/**
 * Types for the Goal Decomposition workflow.
 *
 * The decompose_goal tool follows Option A: the calling agent performs
 * the LLM decomposition; the tool gathers codebase context, validates
 * the proposed DAG, and optionally persists tickets + dependencies.
 */

import type { TicketSeverity } from "../../schemas/ticket.js";

/** A single task proposed by the agent during goal decomposition. */
export interface ProposedTask {
  /** Short task title (max 200 chars). */
  title: string;
  /** Task description (max 2000 chars). */
  description: string;
  /** Paths this task affects. */
  affectedPaths: string[];
  /** Tags for categorization. */
  tags: string[];
  /** Ticket severity. */
  severity: "critical" | "high" | "medium" | "low";
  /** Priority 0-10. */
  priority: number;
  /** Why this task is necessary. */
  rationale: string;
  /**
   * Indices (0-based) of other tasks in the array that this task depends on.
   * Forms a DAG: dependsOn edges become "blocks" links.
   */
  dependsOn: number[];
}

/** Result returned by decompose_goal. */
export interface DecompositionResult {
  /** The original goal string. */
  goal: string;
  /** Optional scope filter that was applied. */
  scope?: string;
  /** The validated proposed tasks. */
  proposedTasks: ProposedTask[];
  /** Dependency edges derived from dependsOn fields. */
  dependencyGraph: Array<{ from: number; to: number }>;
  /** Warnings generated during validation. */
  warnings: string[];
  /** Whether this was a dry run (no tickets created). */
  isDryRun: boolean;
  /** Ticket IDs created (only present when isDryRun is false). */
  createdTicketIds?: string[];
}
