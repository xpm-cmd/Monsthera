import { WorkTemplate, EnrichmentRole, WorkPhase } from "../core/types.js";
import type { EnrichmentRole as EnrichmentRoleType, WorkTemplate as WorkTemplateType, WorkPhase as WorkPhaseType } from "../core/types.js";

// ─── Template Configuration ──────────────────────────────────────────────────

/**
 * Forward phase-graph edges for a template, formatted as `"from:to"` strings.
 * Cancellation from any non-terminal phase is always implicit — do not list it.
 * Tier 2.1 introduced per-template graphs so that documentation-style templates
 * (spike) skip phases that do not apply.
 */
export type PhaseGraphEdge = `${WorkPhaseType}:${WorkPhaseType}`;

/** Configuration for a work article template */
export interface WorkTemplateConfig {
  readonly template: WorkTemplateType;
  readonly requiredSections: readonly string[];
  readonly defaultEnrichmentRoles: readonly EnrichmentRoleType[];
  readonly minEnrichmentCount: number;
  readonly autoAdvance: boolean;
  /** Forward phase-graph edges for this template (Tier 2.1). Cancellation is implicit. */
  readonly phaseGraph: readonly PhaseGraphEdge[];
  /**
   * When true, the `enrichment -> implementation` transition additionally runs the
   * async `snapshot_ready` guard: a fresh snapshot must exist for the article
   * and every HEAD lockfile hash must match the one in the snapshot.
   * Opt-in per template so bugfix / refactor / spike flows stay untouched.
   */
  readonly requiresSnapshotForImplementation?: boolean;
}

const STANDARD_PHASE_GRAPH: readonly PhaseGraphEdge[] = [
  `${WorkPhase.PLANNING}:${WorkPhase.ENRICHMENT}`,
  `${WorkPhase.ENRICHMENT}:${WorkPhase.IMPLEMENTATION}`,
  `${WorkPhase.IMPLEMENTATION}:${WorkPhase.REVIEW}`,
  `${WorkPhase.REVIEW}:${WorkPhase.DONE}`,
];

const SPIKE_PHASE_GRAPH: readonly PhaseGraphEdge[] = [
  `${WorkPhase.PLANNING}:${WorkPhase.ENRICHMENT}`,
  `${WorkPhase.ENRICHMENT}:${WorkPhase.DONE}`,
];

/** Template configurations for all 4 work article types */
export const WORK_TEMPLATES: Record<WorkTemplateType, WorkTemplateConfig> = {
  [WorkTemplate.FEATURE]: {
    template: WorkTemplate.FEATURE,
    requiredSections: ["Objective", "Context", "Acceptance Criteria", "Scope"],
    defaultEnrichmentRoles: [EnrichmentRole.ARCHITECTURE, EnrichmentRole.TESTING],
    minEnrichmentCount: 1,
    autoAdvance: false,
    phaseGraph: STANDARD_PHASE_GRAPH,
    requiresSnapshotForImplementation: true,
  },
  [WorkTemplate.BUGFIX]: {
    template: WorkTemplate.BUGFIX,
    requiredSections: ["Objective", "Steps to Reproduce", "Acceptance Criteria"],
    defaultEnrichmentRoles: [EnrichmentRole.TESTING],
    minEnrichmentCount: 1,
    autoAdvance: false,
    phaseGraph: STANDARD_PHASE_GRAPH,
  },
  [WorkTemplate.REFACTOR]: {
    template: WorkTemplate.REFACTOR,
    requiredSections: ["Objective", "Motivation", "Acceptance Criteria"],
    defaultEnrichmentRoles: [EnrichmentRole.ARCHITECTURE],
    minEnrichmentCount: 1,
    autoAdvance: false,
    phaseGraph: STANDARD_PHASE_GRAPH,
  },
  [WorkTemplate.SPIKE]: {
    template: WorkTemplate.SPIKE,
    requiredSections: ["Objective", "Research Questions"],
    defaultEnrichmentRoles: [],
    minEnrichmentCount: 0,
    autoAdvance: false,
    phaseGraph: SPIKE_PHASE_GRAPH,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get the template configuration for a given work template type */
export function getTemplateConfig(template: WorkTemplateType): WorkTemplateConfig {
  return WORK_TEMPLATES[template];
}

/**
 * Derive the linear phase order for a template by walking its `phaseGraph`
 * forward edges. The first `from` is the entry phase; the last `to` with no
 * outgoing edge is terminal. Used by the convoy guard (ADR-009) so phase
 * comparisons go through the template's actual ordering — string compare
 * would mis-handle spike templates that skip phases.
 *
 * Falls back to inserting any nodes mentioned only as `to` (terminals) at the
 * tail. Cancellation is omitted by convention (it is an implicit terminal).
 */
export function getPhaseOrder(template: WorkTemplateType): readonly WorkPhaseType[] {
  const graph = WORK_TEMPLATES[template].phaseGraph;
  const order: WorkPhaseType[] = [];
  const seen = new Set<WorkPhaseType>();
  for (const edge of graph) {
    const [from, to] = edge.split(":") as [WorkPhaseType, WorkPhaseType];
    if (!seen.has(from)) {
      seen.add(from);
      order.push(from);
    }
    if (!seen.has(to)) {
      seen.add(to);
      order.push(to);
    }
  }
  return order;
}

/** Generate initial markdown content with section headings for a template */
export function generateInitialContent(template: WorkTemplateType): string {
  const config = WORK_TEMPLATES[template];
  return config.requiredSections.map((section) => `## ${section}\n\n`).join("");
}
