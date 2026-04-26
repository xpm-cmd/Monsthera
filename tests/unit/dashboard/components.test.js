import { describe, it, expect } from "vitest";

import { renderMarkdown, renderPhaseChip } from "../../../public/lib/components.js";

describe("dashboard markdown renderer", () => {
  it("renders headings and lists as valid block markup", () => {
    const html = renderMarkdown("# Heading\n\n- first item\n- second item");

    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<ul><li>first item</li><li>second item</li></ul>");
    expect(html).not.toContain("<p><h2>");
  });

  it("renders fenced code blocks and escapes embedded html", () => {
    const html = renderMarkdown("```ts\nconst tag = '<main>';\n```");

    expect(html).toContain("<pre><code>const tag = '&lt;main&gt;';</code></pre>");
  });

  it("keeps safe links and strips unsafe schemes", () => {
    const safe = renderMarkdown("[Docs](https://example.com/docs)");
    const unsafe = renderMarkdown("[Boom](java\tscript:alert(1))");

    expect(safe).toContain('<a href="https://example.com/docs">Docs</a>');
    expect(unsafe).toContain("Boom");
    expect(unsafe).not.toContain("<a href=");
  });
});

describe("renderPhaseChip", () => {
  it("renders a phase as a labeled badge", () => {
    expect(renderPhaseChip("planning")).toContain("planning");
  });
  it("escapes the phase value", () => {
    expect(renderPhaseChip("<script>")).not.toContain("<script>");
  });
  it("preserves phase variant when count is supplied", () => {
    const withCount = renderPhaseChip("planning", 2);
    expect(withCount).toContain("planning ×2");
    // The variant class must match what the bare-phase chip produces.
    const baseline = renderPhaseChip("planning");
    // Extract the badge variant marker (badge--<variant>) from both.
    const variantMatch = baseline.match(/badge--(\w+)/);
    expect(variantMatch).not.toBeNull();
    const variantClass = variantMatch[1];
    expect(withCount).toContain(`badge--${variantClass}`);
  });
});
