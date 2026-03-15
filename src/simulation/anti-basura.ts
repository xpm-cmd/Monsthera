/**
 * Anti-basura: hard validation barrier before any generated ticket touches the DB.
 *
 * Every ticket must pass ALL gates:
 *   1. File existence   — all affectedPaths exist in the repo
 *   2. Deduplication    — title not too similar to existing tickets
 *   3. Actionability    — title is imperative, description has what+why
 *   4. Size check       — estimatedLines fits atomization level
 *   5. Dependency check  — (validated at generator level, not here)
 *   6. Test plan        — acceptanceCriteria is non-empty
 *   7. Planning evidence — all fields populated
 *
 * Tickets that fail any gate are rejected with reason + message, never created.
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { titleSimilarity } from "../tickets/duplicate-detection.js";
import type {
  RejectionReason,
  TicketDescriptor,
  ValidationResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DUPLICATE_THRESHOLD = 0.7;
const MAX_MICRO_LINES = 50;
const MAX_SMALL_LINES = 150;

const IMPERATIVE_PREFIXES = [
  "add",
  "create",
  "implement",
  "fix",
  "reduce",
  "refactor",
  "remove",
  "split",
  "extract",
  "flatten",
  "simplify",
  "update",
  "improve",
  "migrate",
  "replace",
  "move",
  "rename",
  "delete",
  "merge",
  "optimize",
  "convert",
  "wrap",
  "introduce",
  "decouple",
  "integrate",
  "test",
  "validate",
  "enforce",
  "normalize",
  "consolidate",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AntiBasuraContext {
  repoPath: string;
  /** Titles of existing tickets (from DB) for dedup checking. */
  existingTitles: string[];
  /** Titles of already-validated descriptors in this corpus run. */
  corpusTitles: string[];
}

/**
 * Validates a single ticket descriptor against all anti-basura gates.
 * Returns a ValidationResult with all failures (not just the first).
 */
export async function validateDescriptor(
  descriptor: TicketDescriptor,
  ctx: AntiBasuraContext,
): Promise<ValidationResult> {
  const rejections: ValidationResult["rejections"] = [];

  // Gate 1: File existence
  const fileErrors = await checkFileExistence(descriptor, ctx.repoPath);
  rejections.push(...fileErrors);

  // Gate 2: Deduplication
  const dupErrors = checkDuplication(descriptor, ctx);
  rejections.push(...dupErrors);

  // Gate 3: Actionability
  const actionErrors = checkActionability(descriptor);
  rejections.push(...actionErrors);

  // Gate 4: Size check
  const sizeErrors = checkSize(descriptor);
  rejections.push(...sizeErrors);

  // Gate 5: Test plan / acceptance criteria
  const testErrors = checkTestPlan(descriptor);
  rejections.push(...testErrors);

  // Gate 6: Planning evidence
  const evidenceErrors = checkPlanningEvidence(descriptor);
  rejections.push(...evidenceErrors);

  return {
    valid: rejections.length === 0,
    rejections,
  };
}

/**
 * Validates a batch of descriptors, returning valid + rejected lists.
 * Updates corpusTitles as descriptors are validated (so intra-batch dedup works).
 */
export async function validateBatch(
  descriptors: TicketDescriptor[],
  ctx: AntiBasuraContext,
): Promise<{
  valid: TicketDescriptor[];
  rejected: Array<{ descriptor: TicketDescriptor; result: ValidationResult }>;
}> {
  const valid: TicketDescriptor[] = [];
  const rejected: Array<{ descriptor: TicketDescriptor; result: ValidationResult }> = [];

  for (const descriptor of descriptors) {
    const result = await validateDescriptor(descriptor, ctx);
    if (result.valid) {
      valid.push(descriptor);
      ctx.corpusTitles.push(descriptor.title);
    } else {
      rejected.push({ descriptor, result });
    }
  }

  return { valid, rejected };
}

// ---------------------------------------------------------------------------
// Gate implementations
// ---------------------------------------------------------------------------

async function checkFileExistence(
  descriptor: TicketDescriptor,
  repoPath: string,
): Promise<ValidationResult["rejections"]> {
  const errors: ValidationResult["rejections"] = [];

  for (const p of descriptor.affectedPaths) {
    // Skip test file paths that may not exist yet (convention-based)
    if (p.includes(".test.") || p.includes(".spec.")) continue;

    try {
      await access(resolve(repoPath, p));
    } catch {
      errors.push({
        reason: "file_not_found" as RejectionReason,
        message: `File not found: ${p}`,
      });
    }
  }

  return errors;
}

function checkDuplication(
  descriptor: TicketDescriptor,
  ctx: AntiBasuraContext,
): ValidationResult["rejections"] {
  const errors: ValidationResult["rejections"] = [];
  const allTitles = [...ctx.existingTitles, ...ctx.corpusTitles];

  for (const existing of allTitles) {
    const similarity = titleSimilarity(descriptor.title, existing);
    if (similarity >= DUPLICATE_THRESHOLD) {
      errors.push({
        reason: "duplicate" as RejectionReason,
        message: `Too similar to existing ticket: "${existing}" (similarity=${similarity.toFixed(2)})`,
      });
      break; // One duplicate is enough to reject
    }
  }

  return errors;
}

function checkActionability(
  descriptor: TicketDescriptor,
): ValidationResult["rejections"] {
  const errors: ValidationResult["rejections"] = [];

  // Title must start with an imperative verb
  const firstWord = descriptor.title.toLowerCase().split(/\s+/)[0];
  if (!firstWord || !IMPERATIVE_PREFIXES.includes(firstWord)) {
    errors.push({
      reason: "not_actionable" as RejectionReason,
      message: `Title must start with an imperative verb (got "${firstWord}"). Valid prefixes: ${IMPERATIVE_PREFIXES.slice(0, 5).join(", ")}...`,
    });
  }

  // Description must be non-trivial
  if (!descriptor.description || descriptor.description.trim().length < 20) {
    errors.push({
      reason: "not_actionable" as RejectionReason,
      message: "Description must be at least 20 characters and explain what to change and why.",
    });
  }

  return errors;
}

function checkSize(
  descriptor: TicketDescriptor,
): ValidationResult["rejections"] {
  const errors: ValidationResult["rejections"] = [];

  if (descriptor.atomicityLevel === "micro" && descriptor.estimatedLines > MAX_MICRO_LINES) {
    errors.push({
      reason: "too_large" as RejectionReason,
      message: `Micro ticket estimated at ${descriptor.estimatedLines} lines (max ${MAX_MICRO_LINES}). Re-atomize or upgrade to small.`,
    });
  }

  if (descriptor.estimatedLines > MAX_SMALL_LINES) {
    errors.push({
      reason: "too_large" as RejectionReason,
      message: `Ticket estimated at ${descriptor.estimatedLines} lines (max ${MAX_SMALL_LINES}). Must be re-atomized.`,
    });
  }

  return errors;
}

function checkTestPlan(
  descriptor: TicketDescriptor,
): ValidationResult["rejections"] {
  const errors: ValidationResult["rejections"] = [];

  if (!descriptor.acceptanceCriteria || descriptor.acceptanceCriteria.trim().length < 10) {
    errors.push({
      reason: "missing_test_plan" as RejectionReason,
      message: "Acceptance criteria must be non-empty and describe verifiable conditions.",
    });
  }

  return errors;
}

function checkPlanningEvidence(
  descriptor: TicketDescriptor,
): ValidationResult["rejections"] {
  const errors: ValidationResult["rejections"] = [];
  const { planningEvidence } = descriptor;

  if (!planningEvidence) {
    errors.push({
      reason: "missing_planning_evidence" as RejectionReason,
      message: "Planning evidence is required for governance transitions.",
    });
    return errors;
  }

  const requiredFields: Array<keyof typeof planningEvidence> = [
    "summary",
    "approach",
    "affectedAreas",
    "riskAssessment",
    "testPlan",
  ];

  for (const field of requiredFields) {
    const value = planningEvidence[field];
    if (!value || (typeof value === "string" && value.trim().length === 0)) {
      errors.push({
        reason: "missing_planning_evidence" as RejectionReason,
        message: `Planning evidence field "${field}" is empty.`,
      });
    }
    if (Array.isArray(value) && value.length === 0) {
      errors.push({
        reason: "missing_planning_evidence" as RejectionReason,
        message: `Planning evidence field "${field}" is empty.`,
      });
    }
  }

  return errors;
}
