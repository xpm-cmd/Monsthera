import { describe, it, expect } from "vitest";
import {
  WorkArticleFrontmatterSchema,
  CreateWorkArticleInputSchema,
  UpdateWorkArticleInputSchema,
  validateCreateWorkInput,
  validateUpdateWorkInput,
  validateWorkFrontmatter,
} from "../../../src/work/schemas.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const validCreateInput = {
  title: "Add user authentication",
  template: "feature" as const,
  priority: "high" as const,
  author: "xpm",
  tags: ["auth", "security"],
};

const validUpdateInput = {
  title: "Updated: Add user authentication",
  priority: "critical" as const,
  lead: "alice",
  assignee: "bob",
  tags: ["auth", "security", "updated"],
  references: ["https://example.com/spec"],
  codeRefs: ["src/auth/index.ts"],
  content: "Updated content here.",
};

const validFrontmatter = {
  id: "work-001",
  title: "Add user authentication",
  template: "feature" as const,
  phase: "planning" as const,
  priority: "high" as const,
  author: "xpm",
  tags: ["auth", "security"],
  references: [],
  codeRefs: [],
  dependencies: [],
  blockedBy: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

// ─── 1. CreateWorkArticleInputSchema ─────────────────────────────────────────

describe("CreateWorkArticleInputSchema", () => {
  it("accepts a valid create input", () => {
    const result = CreateWorkArticleInputSchema.safeParse(validCreateInput);
    expect(result.success).toBe(true);
  });

  it("rejects missing required field: title", () => {
    const { title: _title, ...withoutTitle } = validCreateInput;
    const result = CreateWorkArticleInputSchema.safeParse(withoutTitle);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field: template", () => {
    const { template: _template, ...withoutTemplate } = validCreateInput;
    const result = CreateWorkArticleInputSchema.safeParse(withoutTemplate);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field: priority", () => {
    const { priority: _priority, ...withoutPriority } = validCreateInput;
    const result = CreateWorkArticleInputSchema.safeParse(withoutPriority);
    expect(result.success).toBe(false);
  });

  it("rejects missing required field: author", () => {
    const { author: _author, ...withoutAuthor } = validCreateInput;
    const result = CreateWorkArticleInputSchema.safeParse(withoutAuthor);
    expect(result.success).toBe(false);
  });

  it("rejects invalid template enum value", () => {
    const result = CreateWorkArticleInputSchema.safeParse({
      ...validCreateInput,
      template: "unknown-template",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid priority enum value", () => {
    const result = CreateWorkArticleInputSchema.safeParse({
      ...validCreateInput,
      priority: "urgent",
    });
    expect(result.success).toBe(false);
  });

  it("defaults tags to [] when omitted", () => {
    const { tags: _tags, ...withoutTags } = validCreateInput;
    const result = CreateWorkArticleInputSchema.safeParse(withoutTags);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
    }
  });

  it("accepts optional content field", () => {
    const result = CreateWorkArticleInputSchema.safeParse({
      ...validCreateInput,
      content: "Some initial content.",
    });
    expect(result.success).toBe(true);
  });
});

// ─── 2. UpdateWorkArticleInputSchema ─────────────────────────────────────────

describe("UpdateWorkArticleInputSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    const result = UpdateWorkArticleInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a valid partial update", () => {
    const result = UpdateWorkArticleInputSchema.safeParse(validUpdateInput);
    expect(result.success).toBe(true);
  });

  it("accepts update with only title", () => {
    const result = UpdateWorkArticleInputSchema.safeParse({ title: "New title" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid priority enum value", () => {
    const result = UpdateWorkArticleInputSchema.safeParse({ priority: "urgent" });
    expect(result.success).toBe(false);
  });

  it("rejects empty title string", () => {
    const result = UpdateWorkArticleInputSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });
});

// ─── 3. WorkArticleFrontmatterSchema ─────────────────────────────────────────

describe("WorkArticleFrontmatterSchema", () => {
  it("accepts valid frontmatter", () => {
    const result = WorkArticleFrontmatterSchema.safeParse(validFrontmatter);
    expect(result.success).toBe(true);
  });

  it("rejects frontmatter missing required field: id", () => {
    const { id: _id, ...withoutId } = validFrontmatter;
    const result = WorkArticleFrontmatterSchema.safeParse(withoutId);
    expect(result.success).toBe(false);
  });

  it("rejects frontmatter missing required field: phase", () => {
    const { phase: _phase, ...withoutPhase } = validFrontmatter;
    const result = WorkArticleFrontmatterSchema.safeParse(withoutPhase);
    expect(result.success).toBe(false);
  });

  it("rejects invalid phase enum value", () => {
    const result = WorkArticleFrontmatterSchema.safeParse({
      ...validFrontmatter,
      phase: "in-progress",
    });
    expect(result.success).toBe(false);
  });

  it("defaults tags to [] when omitted", () => {
    const { tags: _tags, ...withoutTags } = validFrontmatter;
    const result = WorkArticleFrontmatterSchema.safeParse(withoutTags);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
    }
  });

  it("defaults references, codeRefs, dependencies, blockedBy to [] when omitted", () => {
    const { references: _r, codeRefs: _c, dependencies: _d, blockedBy: _b, ...minimal } = validFrontmatter;
    const result = WorkArticleFrontmatterSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.references).toEqual([]);
      expect(result.data.codeRefs).toEqual([]);
      expect(result.data.dependencies).toEqual([]);
      expect(result.data.blockedBy).toEqual([]);
    }
  });

  it("accepts optional completedAt field", () => {
    const result = WorkArticleFrontmatterSchema.safeParse({
      ...validFrontmatter,
      completedAt: "2026-02-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

// ─── 4. validateCreateWorkInput ───────────────────────────────────────────────

describe("validateCreateWorkInput", () => {
  it("returns ok with data for valid input", () => {
    const result = validateCreateWorkInput(validCreateInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe(validCreateInput.title);
      expect(result.value.author).toBe(validCreateInput.author);
      expect(result.value.template).toBe(validCreateInput.template);
    }
  });

  it("returns err with ValidationError for missing title", () => {
    const result = validateCreateWorkInput({ template: "feature", priority: "high", author: "xpm" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ValidationError");
      expect(result.error.message).toMatch(/invalid create work article input/i);
      expect(result.error.details).toHaveProperty("issues");
      expect(Array.isArray((result.error.details as Record<string, unknown>)["issues"])).toBe(true);
    }
  });

  it("returns err with ValidationError for null input", () => {
    const result = validateCreateWorkInput(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ValidationError");
      expect(result.error.details).toHaveProperty("issues");
    }
  });
});

// ─── 5. validateUpdateWorkInput ───────────────────────────────────────────────

describe("validateUpdateWorkInput", () => {
  it("returns ok for empty object", () => {
    const result = validateUpdateWorkInput({});
    expect(result.ok).toBe(true);
  });

  it("returns ok for valid partial update", () => {
    const result = validateUpdateWorkInput({ title: "New title", priority: "low" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("New title");
      expect(result.value.priority).toBe("low");
    }
  });

  it("returns err for invalid priority enum", () => {
    const result = validateUpdateWorkInput({ priority: "not-a-priority" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ValidationError");
      expect(result.error.message).toMatch(/invalid update work article input/i);
      expect(result.error.details).toHaveProperty("issues");
    }
  });
});

// ─── 6. validateWorkFrontmatter ───────────────────────────────────────────────

describe("validateWorkFrontmatter", () => {
  it("returns ok with data for valid frontmatter", () => {
    const result = validateWorkFrontmatter(validFrontmatter);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(validFrontmatter.id);
      expect(result.value.phase).toBe(validFrontmatter.phase);
    }
  });

  it("returns err with ValidationError for missing id", () => {
    const { id: _id, ...withoutId } = validFrontmatter;
    const result = validateWorkFrontmatter(withoutId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ValidationError");
      expect(result.error.message).toMatch(/invalid work article frontmatter/i);
      expect(result.error.details).toHaveProperty("issues");
    }
  });

  it("returns err with ValidationError for invalid phase", () => {
    const result = validateWorkFrontmatter({ ...validFrontmatter, phase: "bad-phase" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ValidationError");
      expect(result.error.details).toHaveProperty("issues");
    }
  });
});

// ─── 7. Edge cases ────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("extra properties are stripped (passthrough not enabled)", () => {
    const result = CreateWorkArticleInputSchema.safeParse({
      ...validCreateInput,
      unknownField: "should be stripped",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).not.toContain("unknownField");
    }
  });

  it("title at exactly 200 characters is accepted", () => {
    const result = CreateWorkArticleInputSchema.safeParse({
      ...validCreateInput,
      title: "a".repeat(200),
    });
    expect(result.success).toBe(true);
  });

  it("title over 200 characters is rejected", () => {
    const result = CreateWorkArticleInputSchema.safeParse({
      ...validCreateInput,
      title: "a".repeat(201),
    });
    expect(result.success).toBe(false);
  });
});
