import { describe, it, expect } from "vitest";

import { renderMarkdown } from "../../../public/lib/components.js";

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
