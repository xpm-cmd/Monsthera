import { describe, it, expect } from "vitest";
import {
  parseMarkdown,
  serializeMarkdown,
  serializeFrontmatterValue,
  patchFrontmatter,
} from "../../../src/knowledge/markdown.js";

// ---------------------------------------------------------------------------
// parseMarkdown
// ---------------------------------------------------------------------------
describe("parseMarkdown", () => {
  it("1. parses valid frontmatter with string values", () => {
    const input = `---\ntitle: Hello World\nauthor: Alice\n---\nBody text.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter).toEqual({ title: "Hello World", author: "Alice" });
    expect(result.value.body).toBe("Body text.");
  });

  it("2. parses frontmatter with inline array [a, b, c]", () => {
    const input = `---\ntags: [alpha, beta, gamma]\n---\nBody.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  it("3. parses frontmatter with multi-line list array (- item)", () => {
    const input = `---\ntags:\n  - item1\n  - item2\n  - item3\n---\nBody.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.tags).toEqual(["item1", "item2", "item3"]);
  });

  it("4. parses frontmatter with mixed types (string, boolean, number)", () => {
    const input = `---\ntitle: Guide\nenabled: true\nport: 3000\n---\nBody.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter).toEqual({ title: "Guide", enabled: true, port: 3000 });
  });

  it("5. parses frontmatter with double-quoted values", () => {
    const input = `---\ntitle: "API: Design Guide"\n---\nBody.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.title).toBe("API: Design Guide");
  });

  it("6. parses frontmatter with empty values (key:)", () => {
    const input = `---\ntitle:\ndescription:\n---\nBody.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.title).toBe("");
    expect(result.value.frontmatter.description).toBe("");
  });

  it("7. preserves body content exactly (whitespace, headings)", () => {
    const body = `# Heading\n\nSome paragraph.\n\n  indented line\n`;
    const input = `---\ntitle: Test\n---\n${body}`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toBe(body);
  });

  it("8. preserves body with code blocks", () => {
    const body = "```typescript\nconst x = 1;\n```\n";
    const input = `---\ntitle: Code\n---\n${body}`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toBe(body);
  });

  it("9. errors when no frontmatter delimiters (plain text)", () => {
    const result = parseMarkdown("Just plain text without any frontmatter.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/frontmatter/i);
  });

  it("10. errors when only opening --- present (no closing)", () => {
    const result = parseMarkdown("---\ntitle: Test\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/frontmatter/i);
  });

  it("11. errors on empty input string", () => {
    const result = parseMarkdown("");
    expect(result.ok).toBe(false);
  });

  it("12. body containing --- on its own line NOT confused with frontmatter", () => {
    const input = `---\ntitle: Test\n---\nBefore separator.\n---\nAfter separator.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toBe("Before separator.\n---\nAfter separator.");
    expect(result.value.frontmatter).toEqual({ title: "Test" });
  });

  it("13. trims trailing whitespace on values", () => {
    const input = `---\ntitle: Hello   \nauthor: Bob  \n---\nBody.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.title).toBe("Hello");
    expect(result.value.frontmatter.author).toBe("Bob");
  });

  it("14. handles Windows line endings (CRLF)", () => {
    const input = "---\r\ntitle: Windows\r\nenabled: true\r\n---\r\nBody text.";
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.title).toBe("Windows");
    expect(result.value.frontmatter.enabled).toBe(true);
    expect(result.value.body).toBe("Body text.");
  });
});

// ---------------------------------------------------------------------------
// serializeMarkdown
// ---------------------------------------------------------------------------
describe("serializeMarkdown", () => {
  it("15. serializes basic frontmatter + body", () => {
    const result = serializeMarkdown({ title: "Hello", author: "Alice" }, "Body text.");
    expect(result).toBe("---\ntitle: Hello\nauthor: Alice\n---\n\nBody text.");
  });

  it("16. serializes arrays in inline format [a, b, c]", () => {
    const result = serializeMarkdown({ tags: ["a", "b", "c"] }, "Body.");
    expect(result).toBe("---\ntags: [a, b, c]\n---\n\nBody.");
  });

  it("17. serializes with empty body", () => {
    const result = serializeMarkdown({ title: "Empty" }, "");
    expect(result).toBe("---\ntitle: Empty\n---\n\n");
  });

  it("18. serializes with empty frontmatter (just delimiters)", () => {
    const result = serializeMarkdown({}, "Some body.");
    expect(result).toBe("---\n---\n\nSome body.");
  });
});

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------
describe("round-trip", () => {
  it("19. parse then serialize produces equivalent output", () => {
    // Body must not start with \n to avoid serializer adding a second blank line
    const original = "---\ntitle: Round Trip\ntags: [x, y]\nenabled: true\n---\nBody content.";
    const parsed = parseMarkdown(original);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const serialized = serializeMarkdown(parsed.value.frontmatter, parsed.value.body);
    const reparsed = parseMarkdown(serialized);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.frontmatter).toEqual(parsed.value.frontmatter);
    expect(reparsed.value.body).toBe(parsed.value.body);
  });

  it("20. serialize then parse recovers same data", () => {
    const frontmatter = { title: "Test Doc", count: 42, active: true, tags: ["a", "b"] };
    const body = "# Heading\n\nContent here.";
    const serialized = serializeMarkdown(frontmatter, body);
    const parsed = parseMarkdown(serialized);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frontmatter.title).toBe("Test Doc");
    expect(parsed.value.frontmatter.count).toBe(42);
    expect(parsed.value.frontmatter.active).toBe(true);
    expect(parsed.value.frontmatter.tags).toEqual(["a", "b"]);
    expect(parsed.value.body).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("21. frontmatter with colon in quoted value", () => {
    const input = `---\ntitle: "API: Design Guide"\nversion: "2.0: stable"\n---\nBody.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.title).toBe("API: Design Guide");
    expect(result.value.frontmatter.version).toBe("2.0: stable");
  });

  it("22. body with markdown headings not confused with frontmatter", () => {
    const input = `---\ntitle: Article\n---\n# Main Heading\n## Sub Heading\nContent.`;
    const result = parseMarkdown(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter).toEqual({ title: "Article" });
    expect(result.value.body).toBe("# Main Heading\n## Sub Heading\nContent.");
  });
});

// ---------------------------------------------------------------------------
// serializeFrontmatterValue (shared value serializer — T5)
// ---------------------------------------------------------------------------
describe("serializeFrontmatterValue", () => {
  it("23. serializes a string array as inline [a, b, c]", () => {
    expect(serializeFrontmatterValue(["a", "b", "c"])).toBe("[a, b, c]");
  });

  it("24. serializes an empty array as []", () => {
    expect(serializeFrontmatterValue([])).toBe("[]");
  });

  it("25. serializes scalars via String()", () => {
    expect(serializeFrontmatterValue("Hello")).toBe("Hello");
    expect(serializeFrontmatterValue(42)).toBe("42");
    expect(serializeFrontmatterValue(true)).toBe("true");
  });

  it("26. agrees with serializeMarkdown's array + scalar formatting", () => {
    // The serializer and the patcher MUST agree, so serializeMarkdown is
    // expressed in terms of serializeFrontmatterValue. Lock that in.
    expect(serializeMarkdown({ tags: ["a", "b"] }, "B")).toContain(
      `tags: ${serializeFrontmatterValue(["a", "b"])}`,
    );
    expect(serializeMarkdown({ port: 3000 }, "B")).toContain(
      `port: ${serializeFrontmatterValue(3000)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// patchFrontmatter (minimal-diff line patch — T5)
// ---------------------------------------------------------------------------
describe("patchFrontmatter", () => {
  // A flow-style file with a double-quoted colon-title and a body that also
  // contains a colon — the shapes a full re-serialize would mangle.
  const raw = [
    "---",
    'title: "API: Design"',
    "tags: [a, b]",
    "updatedAt: 2026-05-15T10:00:00Z",
    "---",
    "",
    "Body: with a colon.",
    "",
  ].join("\n");

  it("27. rewrites only the changed key's line, leaving all other bytes intact", () => {
    const out = patchFrontmatter(raw, { tags: "[a, b, c]" });
    expect(out).toBe(
      [
        "---",
        'title: "API: Design"',
        "tags: [a, b, c]",
        "updatedAt: 2026-05-15T10:00:00Z",
        "---",
        "",
        "Body: with a colon.",
        "",
      ].join("\n"),
    );
  });

  it("28. preserves a double-quoted colon-title verbatim when patching another key", () => {
    const out = patchFrontmatter(raw, { updatedAt: "2026-05-31T00:00:00Z" });
    expect(out).not.toBeNull();
    expect(out).toContain('title: "API: Design"');
    expect(out).toContain("updatedAt: 2026-05-31T00:00:00Z");
    // The old timestamp is gone; everything else (incl. the body colon) stays.
    expect(out).toContain("Body: with a colon.");
    expect(out).not.toContain("updatedAt: 2026-05-15T10:00:00Z");
  });

  it("29. patches multiple changed keys in a single pass", () => {
    const out = patchFrontmatter(raw, {
      tags: "[x]",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    expect(out).toContain("tags: [x]");
    expect(out).toContain("updatedAt: 2026-06-01T00:00:00Z");
    expect(out).toContain('title: "API: Design"');
  });

  it("30. returns null for block-style list frontmatter (unsafe to line-patch)", () => {
    const block = ["---", "tags:", "  - a", "  - b", "---", "", "Body."].join("\n");
    expect(patchFrontmatter(block, { tags: "[a, b, c]" })).toBeNull();
  });

  it("31. returns null when a changed key is not present as its own line", () => {
    expect(patchFrontmatter(raw, { sourcePath: "notes/x.md" })).toBeNull();
  });

  it("32. returns null when the opening delimiter is missing", () => {
    expect(patchFrontmatter("title: x\n---\nBody.", { title: "y" })).toBeNull();
  });

  it("33. returns null when there is no closing delimiter", () => {
    expect(patchFrontmatter("---\ntitle: x\n", { title: "y" })).toBeNull();
  });
});
