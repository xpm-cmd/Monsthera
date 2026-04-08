import { describe, it, expect } from "vitest";
import { WORK_TEMPLATES, getTemplateConfig, generateInitialContent } from "../../../src/work/templates.js";
import { WorkTemplate, EnrichmentRole } from "../../../src/core/types.js";

// ─── WORK_TEMPLATES ──────────────────────────────────────────────────────────

describe("WORK_TEMPLATES", () => {
  it("has exactly 4 templates", () => {
    expect(Object.keys(WORK_TEMPLATES)).toHaveLength(4);
  });

  it("contains feature, bugfix, refactor, and spike keys", () => {
    expect(WORK_TEMPLATES).toHaveProperty(WorkTemplate.FEATURE);
    expect(WORK_TEMPLATES).toHaveProperty(WorkTemplate.BUGFIX);
    expect(WORK_TEMPLATES).toHaveProperty(WorkTemplate.REFACTOR);
    expect(WORK_TEMPLATES).toHaveProperty(WorkTemplate.SPIKE);
  });

  it("each template has the correct template field value", () => {
    expect(WORK_TEMPLATES[WorkTemplate.FEATURE].template).toBe(WorkTemplate.FEATURE);
    expect(WORK_TEMPLATES[WorkTemplate.BUGFIX].template).toBe(WorkTemplate.BUGFIX);
    expect(WORK_TEMPLATES[WorkTemplate.REFACTOR].template).toBe(WorkTemplate.REFACTOR);
    expect(WORK_TEMPLATES[WorkTemplate.SPIKE].template).toBe(WorkTemplate.SPIKE);
  });
});

// ─── Feature Template ─────────────────────────────────────────────────────────

describe("Feature template", () => {
  const config = WORK_TEMPLATES[WorkTemplate.FEATURE];

  it("has the correct requiredSections", () => {
    expect(config.requiredSections).toEqual(["Objective", "Context", "Acceptance Criteria", "Scope"]);
  });

  it("defaultEnrichmentRoles includes architecture and testing", () => {
    expect(config.defaultEnrichmentRoles).toContain(EnrichmentRole.ARCHITECTURE);
    expect(config.defaultEnrichmentRoles).toContain(EnrichmentRole.TESTING);
  });

  it("minEnrichmentCount is 1", () => {
    expect(config.minEnrichmentCount).toBe(1);
  });

  it("autoAdvance is false", () => {
    expect(config.autoAdvance).toBe(false);
  });
});

// ─── Bugfix Template ──────────────────────────────────────────────────────────

describe("Bugfix template", () => {
  const config = WORK_TEMPLATES[WorkTemplate.BUGFIX];

  it("has the correct requiredSections", () => {
    expect(config.requiredSections).toEqual(["Objective", "Steps to Reproduce", "Acceptance Criteria"]);
  });

  it("defaultEnrichmentRoles includes testing", () => {
    expect(config.defaultEnrichmentRoles).toContain(EnrichmentRole.TESTING);
  });

  it("minEnrichmentCount is 1", () => {
    expect(config.minEnrichmentCount).toBe(1);
  });

  it("autoAdvance is false", () => {
    expect(config.autoAdvance).toBe(false);
  });
});

// ─── Refactor Template ────────────────────────────────────────────────────────

describe("Refactor template", () => {
  const config = WORK_TEMPLATES[WorkTemplate.REFACTOR];

  it("has the correct requiredSections", () => {
    expect(config.requiredSections).toEqual(["Objective", "Motivation", "Acceptance Criteria"]);
  });

  it("defaultEnrichmentRoles includes architecture", () => {
    expect(config.defaultEnrichmentRoles).toContain(EnrichmentRole.ARCHITECTURE);
  });

  it("minEnrichmentCount is 1", () => {
    expect(config.minEnrichmentCount).toBe(1);
  });

  it("autoAdvance is false", () => {
    expect(config.autoAdvance).toBe(false);
  });
});

// ─── Spike Template ───────────────────────────────────────────────────────────

describe("Spike template", () => {
  const config = WORK_TEMPLATES[WorkTemplate.SPIKE];

  it("has the correct requiredSections", () => {
    expect(config.requiredSections).toEqual(["Objective", "Research Questions"]);
  });

  it("defaultEnrichmentRoles is empty", () => {
    expect(config.defaultEnrichmentRoles).toHaveLength(0);
  });

  it("minEnrichmentCount is 0", () => {
    expect(config.minEnrichmentCount).toBe(0);
  });

  it("autoAdvance is false", () => {
    expect(config.autoAdvance).toBe(false);
  });
});

// ─── getTemplateConfig ────────────────────────────────────────────────────────

describe("getTemplateConfig", () => {
  it("returns the correct config for feature", () => {
    expect(getTemplateConfig(WorkTemplate.FEATURE)).toBe(WORK_TEMPLATES[WorkTemplate.FEATURE]);
  });

  it("returns the correct config for bugfix", () => {
    expect(getTemplateConfig(WorkTemplate.BUGFIX)).toBe(WORK_TEMPLATES[WorkTemplate.BUGFIX]);
  });

  it("returns the correct config for refactor", () => {
    expect(getTemplateConfig(WorkTemplate.REFACTOR)).toBe(WORK_TEMPLATES[WorkTemplate.REFACTOR]);
  });

  it("returns the correct config for spike", () => {
    expect(getTemplateConfig(WorkTemplate.SPIKE)).toBe(WORK_TEMPLATES[WorkTemplate.SPIKE]);
  });

  it("returned config matches WORK_TEMPLATES entry", () => {
    for (const template of Object.values(WorkTemplate)) {
      expect(getTemplateConfig(template)).toStrictEqual(WORK_TEMPLATES[template]);
    }
  });
});

// ─── generateInitialContent ───────────────────────────────────────────────────

describe("generateInitialContent", () => {
  it("feature content includes all 4 section headings", () => {
    const content = generateInitialContent(WorkTemplate.FEATURE);
    expect(content).toContain("## Objective");
    expect(content).toContain("## Context");
    expect(content).toContain("## Acceptance Criteria");
    expect(content).toContain("## Scope");
  });

  it("bugfix content includes ## Steps to Reproduce", () => {
    const content = generateInitialContent(WorkTemplate.BUGFIX);
    expect(content).toContain("## Steps to Reproduce");
  });

  it("spike content includes ## Research Questions and ## Objective", () => {
    const content = generateInitialContent(WorkTemplate.SPIKE);
    expect(content).toContain("## Research Questions");
    expect(content).toContain("## Objective");
  });

  it("feature content does not include unrelated sections", () => {
    const content = generateInitialContent(WorkTemplate.FEATURE);
    expect(content).not.toContain("## Steps to Reproduce");
    expect(content).not.toContain("## Research Questions");
    expect(content).not.toContain("## Motivation");
  });

  it("spike content does not include unrelated sections", () => {
    const content = generateInitialContent(WorkTemplate.SPIKE);
    expect(content).not.toContain("## Steps to Reproduce");
    expect(content).not.toContain("## Scope");
    expect(content).not.toContain("## Acceptance Criteria");
  });

  it("content uses ## prefix for headings", () => {
    for (const template of Object.values(WorkTemplate)) {
      const content = generateInitialContent(template);
      const lines = content.split("\n").filter((l) => l.trim().startsWith("#"));
      expect(lines.every((l) => l.startsWith("## "))).toBe(true);
    }
  });
});
