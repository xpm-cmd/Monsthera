import { describe, it, expect } from "vitest";
import {
  ArticleFrontmatterSchema,
  CreateArticleInputSchema,
  UpdateArticleInputSchema,
  validateCreateInput,
  validateUpdateInput,
  validateFrontmatter,
} from "../../../src/knowledge/schemas.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const validCreateInput = {
  title: "Understanding Result Types",
  category: "architecture",
  content: "Result types are a way to handle errors without exceptions.",
  tags: ["typescript", "errors"],
  codeRefs: ["src/core/result.ts"],
};

const validUpdateInput = {
  title: "Updated Title",
  category: "patterns",
  content: "Updated content here.",
  tags: ["updated"],
  codeRefs: ["src/updated.ts"],
};

const validFrontmatter = {
  id: "article-001",
  title: "Understanding Result Types",
  slug: "understanding-result-types",
  category: "architecture",
  tags: ["typescript", "errors"],
  codeRefs: ["src/core/result.ts"],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

// ─── 1. Schema acceptance ─────────────────────────────────────────────────────

describe("schema acceptance", () => {
  it("accepts a valid create input", () => {
    const result = CreateArticleInputSchema.safeParse(validCreateInput);
    expect(result.success).toBe(true);
  });

  it("accepts a valid update input", () => {
    const result = UpdateArticleInputSchema.safeParse(validUpdateInput);
    expect(result.success).toBe(true);
  });

  it("accepts valid article frontmatter", () => {
    const result = ArticleFrontmatterSchema.safeParse(validFrontmatter);
    expect(result.success).toBe(true);
  });
});

// ─── 2. Schema rejection ──────────────────────────────────────────────────────

describe("schema rejection", () => {
  it("rejects create input with missing title", () => {
    const { title: _title, ...withoutTitle } = validCreateInput;
    const result = CreateArticleInputSchema.safeParse(withoutTitle);
    expect(result.success).toBe(false);
  });

  it("rejects create input with empty content", () => {
    const result = CreateArticleInputSchema.safeParse({
      ...validCreateInput,
      content: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects create input with title exceeding 200 characters", () => {
    const result = CreateArticleInputSchema.safeParse({
      ...validCreateInput,
      title: "a".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("rejects create input with category exceeding 100 characters", () => {
    const result = CreateArticleInputSchema.safeParse({
      ...validCreateInput,
      category: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("rejects frontmatter missing required fields (id and slug)", () => {
    const { id: _id, slug: _slug, ...withoutRequired } = validFrontmatter;
    const result = ArticleFrontmatterSchema.safeParse(withoutRequired);
    expect(result.success).toBe(false);
  });
});

// ─── 3. Default values ────────────────────────────────────────────────────────

describe("default values", () => {
  it("defaults tags to [] when omitted in create input", () => {
    const { tags: _tags, ...withoutTags } = validCreateInput;
    const result = CreateArticleInputSchema.safeParse(withoutTags);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
    }
  });

  it("defaults codeRefs to [] when omitted in create input", () => {
    const { codeRefs: _codeRefs, ...withoutCodeRefs } = validCreateInput;
    const result = CreateArticleInputSchema.safeParse(withoutCodeRefs);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.codeRefs).toEqual([]);
    }
  });
});

// ─── 4. Validation function happy paths ──────────────────────────────────────

describe("validation function happy paths", () => {
  it("validateCreateInput returns ok for valid input", () => {
    const result = validateCreateInput(validCreateInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe(validCreateInput.title);
      expect(result.value.category).toBe(validCreateInput.category);
      expect(result.value.content).toBe(validCreateInput.content);
    }
  });

  it("validateUpdateInput returns ok for valid input", () => {
    const result = validateUpdateInput(validUpdateInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe(validUpdateInput.title);
    }
  });

  it("validateFrontmatter returns ok for valid frontmatter", () => {
    const result = validateFrontmatter(validFrontmatter);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(validFrontmatter.id);
      expect(result.value.slug).toBe(validFrontmatter.slug);
    }
  });
});

// ─── 5. Validation function error paths ──────────────────────────────────────

describe("validation function error paths", () => {
  it("validateCreateInput returns err(ValidationError) for missing title", () => {
    const result = validateCreateInput({ category: "arch", content: "text" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ValidationError");
      expect(result.error.message).toMatch(/invalid create article input/i);
      expect(result.error.details).toHaveProperty("issues");
      expect(Array.isArray((result.error.details as Record<string, unknown>)["issues"])).toBe(true);
    }
  });

  it("validateUpdateInput returns err(ValidationError) for empty title string", () => {
    const result = validateUpdateInput({ title: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ValidationError");
      expect(result.error.message).toMatch(/invalid update article input/i);
      expect(result.error.details).toHaveProperty("issues");
    }
  });

  it("validateFrontmatter returns err(ValidationError) for missing id", () => {
    const { id: _id, ...withoutId } = validFrontmatter;
    const result = validateFrontmatter(withoutId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ValidationError");
      expect(result.error.message).toMatch(/invalid article frontmatter/i);
      expect(result.error.details).toHaveProperty("issues");
    }
  });

  it("validateCreateInput returns err(ValidationError) for non-object input", () => {
    const result = validateCreateInput(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ValidationError");
      expect(result.error.details).toHaveProperty("issues");
    }
  });
});

// ─── 6. Edge cases ────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("empty update object is valid (all fields optional)", () => {
    const result = validateUpdateInput({});
    expect(result.ok).toBe(true);
  });

  it("extra properties are stripped (passthrough is not enabled)", () => {
    const result = CreateArticleInputSchema.safeParse({
      ...validCreateInput,
      unknownField: "should be stripped",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).not.toContain("unknownField");
    }
  });

  it("update with no fields returns ok with empty-ish object", () => {
    const result = validateUpdateInput({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBeUndefined();
      expect(result.value.category).toBeUndefined();
      expect(result.value.content).toBeUndefined();
    }
  });
});
