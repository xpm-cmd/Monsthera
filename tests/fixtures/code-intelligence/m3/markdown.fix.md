# Phase 1 TextMate extractor fixture - Markdown.

Plain test data. The extractor produces zero symbols for Markdown
files: per ADR-017 D3, code-only kinds map cleanly onto programming
languages, and prose files only carry the file-level entry that the
inventory service synthesises in Phase 2.

## Section heading

A paragraph with `inline code` and **bold** and _italic_.

```ts
function notExtracted() {
  return 1;
}
```

- bullet one
- bullet two

> A blockquote, also not parsed for symbols.
