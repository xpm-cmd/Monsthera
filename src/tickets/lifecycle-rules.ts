import { TicketSeverity, type TicketStatus } from "../../schemas/ticket.js";
import type { LifecycleConfig } from "../core/config.js";

export interface LifecycleRuleResult {
  shouldFire: boolean;
  targetStatus: TicketStatus;
  reason: string;
}

const SEVERITY_ORDER = TicketSeverity.options; // ["critical", "high", "medium", "low"]

function severityMeetsThreshold(severity: string, threshold: string): boolean {
  const severityIdx = SEVERITY_ORDER.indexOf(severity as typeof SEVERITY_ORDER[number]);
  const thresholdIdx = SEVERITY_ORDER.indexOf(threshold as typeof SEVERITY_ORDER[number]);
  if (severityIdx === -1 || thresholdIdx === -1) return false;
  return severityIdx <= thresholdIdx; // lower index = higher severity
}

/** Rule 1: backlog → technical_analysis on ticket creation */
export function shouldAutoTriage(
  ticket: { status: string; severity: string; priority: number },
  config: LifecycleConfig,
): LifecycleRuleResult {
  const no: LifecycleRuleResult = { shouldFire: false, targetStatus: "technical_analysis", reason: "" };

  if (!config.autoTriageOnCreate) return no;
  if (ticket.status !== "backlog") return no;
  if (!severityMeetsThreshold(ticket.severity, config.autoTriageSeverityThreshold)) return no;
  if (ticket.priority < config.autoTriagePriorityThreshold) return no;

  return {
    shouldFire: true,
    targetStatus: "technical_analysis",
    reason: `Auto-triaged: severity=${ticket.severity}, priority=${ticket.priority}`,
  };
}

/** Rule 2: resolved → closed after configured age */
export function shouldAutoClose(
  ticket: { status: string; updatedAt: string },
  config: LifecycleConfig,
  now: number,
): LifecycleRuleResult {
  const no: LifecycleRuleResult = { shouldFire: false, targetStatus: "closed", reason: "" };

  if (config.autoCloseResolvedAfterMs <= 0) return no;
  if (ticket.status !== "resolved") return no;

  const updatedAt = new Date(ticket.updatedAt).getTime();
  const age = now - updatedAt;
  if (age < config.autoCloseResolvedAfterMs) return no;

  return {
    shouldFire: true,
    targetStatus: "closed",
    reason: `Auto-closed: resolved for ${Math.round(age / 3_600_000)}h (config: autoCloseResolvedAfterMs=${config.autoCloseResolvedAfterMs})`,
  };
}

/** Rule 3: in_progress → in_review when a validated patch is linked */
export function shouldAutoReview(
  ticket: { status: string },
  patchState: string,
  config: LifecycleConfig,
): LifecycleRuleResult {
  const no: LifecycleRuleResult = { shouldFire: false, targetStatus: "in_review", reason: "" };

  if (!config.autoReviewOnPatch) return no;
  if (ticket.status !== "in_progress") return no;
  if (patchState !== "validated") return no;

  return {
    shouldFire: true,
    targetStatus: "in_review",
    reason: "Auto-reviewed: validated patch linked",
  };
}

const TERMINAL_STATUSES = new Set<string>(["resolved", "closed", "wont_fix"]);

/** Rule 4: blocked → in_progress when all blockers reach a terminal state */
export function shouldAutoUnblock(
  ticket: { status: string },
  blockerStatuses: string[],
  config: LifecycleConfig,
  wasLifecycleBlocked: boolean,
): LifecycleRuleResult {
  const no: LifecycleRuleResult = { shouldFire: false, targetStatus: "in_progress", reason: "" };

  if (!config.autoCascadeBlocked) return no;
  if (ticket.status !== "blocked") return no;
  if (blockerStatuses.length === 0) return no;
  if (!wasLifecycleBlocked) return no;
  if (!blockerStatuses.every((s) => TERMINAL_STATUSES.has(s))) return no;

  return {
    shouldFire: true,
    targetStatus: "in_progress",
    reason: `Auto-unblocked: all ${blockerStatuses.length} blocking tickets resolved`,
  };
}
