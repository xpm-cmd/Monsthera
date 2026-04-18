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

/** Generate initial markdown content with section headings for a template */
export function generateInitialContent(template: WorkTemplateType): string {
  const config = WORK_TEMPLATES[template];
  return config.requiredSections.map((section) => `## ${section}\n\n`).join("");
}
