import { WorkTemplate, EnrichmentRole } from "../core/types.js";
import type { EnrichmentRole as EnrichmentRoleType, WorkTemplate as WorkTemplateType } from "../core/types.js";

// ─── Template Configuration ──────────────────────────────────────────────────

/** Configuration for a work article template */
export interface WorkTemplateConfig {
  readonly template: WorkTemplateType;
  readonly requiredSections: readonly string[];
  readonly defaultEnrichmentRoles: readonly EnrichmentRoleType[];
  readonly minEnrichmentCount: number;
  readonly autoAdvance: boolean;
}

/** Template configurations for all 4 work article types */
export const WORK_TEMPLATES: Record<WorkTemplateType, WorkTemplateConfig> = {
  [WorkTemplate.FEATURE]: {
    template: WorkTemplate.FEATURE,
    requiredSections: ["Objective", "Context", "Acceptance Criteria", "Scope"],
    defaultEnrichmentRoles: [EnrichmentRole.ARCHITECTURE, EnrichmentRole.TESTING],
    minEnrichmentCount: 1,
    autoAdvance: false,
  },
  [WorkTemplate.BUGFIX]: {
    template: WorkTemplate.BUGFIX,
    requiredSections: ["Objective", "Steps to Reproduce", "Acceptance Criteria"],
    defaultEnrichmentRoles: [EnrichmentRole.TESTING],
    minEnrichmentCount: 1,
    autoAdvance: false,
  },
  [WorkTemplate.REFACTOR]: {
    template: WorkTemplate.REFACTOR,
    requiredSections: ["Objective", "Motivation", "Acceptance Criteria"],
    defaultEnrichmentRoles: [EnrichmentRole.ARCHITECTURE],
    minEnrichmentCount: 1,
    autoAdvance: false,
  },
  [WorkTemplate.SPIKE]: {
    template: WorkTemplate.SPIKE,
    requiredSections: ["Objective", "Research Questions"],
    defaultEnrichmentRoles: [],
    minEnrichmentCount: 0,
    autoAdvance: false,
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
