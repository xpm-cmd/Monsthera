import { describe, it, expect } from "vitest";
import { validateCreateInput, validateUpdateInput } from "../../../src/knowledge/schemas.js";

// ADR-020 P1: the Zod input boundary used to strip unknown keys, so
// extraFrontmatter never reached the repo. These pin that it is now retained.
describe("custom frontmatter on input schemas (ADR-020 P1)", () => {
  it("retains extraFrontmatter on create input", () => {
    const r = validateCreateInput({
      title: "T",
      category: "context",
      content: "c",
      extraFrontmatter: { origin: "human", ticket: "ABC-123" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.extraFrontmatter).toEqual({ origin: "human", ticket: "ABC-123" });
  });

  it("retains extraFrontmatter on update input", () => {
    const r = validateUpdateInput({ extraFrontmatter: { ticket: "X-1" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.extraFrontmatter).toEqual({ ticket: "X-1" });
  });

  it("leaves extraFrontmatter absent when not supplied", () => {
    const r = validateCreateInput({ title: "T", category: "context", content: "c" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.extraFrontmatter).toBeUndefined();
  });
});
