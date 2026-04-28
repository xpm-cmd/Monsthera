import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resetExtractorCachesForTesting,
  TextMateSymbolExtractor,
} from "../../../../src/code-intelligence/inventory/extractor.js";
import {
  loadedLanguages,
  resetLoadedLanguagesForTesting,
} from "../../../../src/code-intelligence/inventory/language-map.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(
  __dirname,
  "../../../fixtures/code-intelligence/m3",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

interface ExpectedSymbol {
  readonly kind: string;
  readonly name: string;
  readonly startLine: number;
}

function summarise(
  artifacts: ReadonlyArray<{
    readonly kind: string;
    readonly name: string;
    readonly startLine?: number;
  }>,
): readonly ExpectedSymbol[] {
  return artifacts.map((a) => ({
    kind: a.kind,
    name: a.name,
    startLine: a.startLine ?? 0,
  }));
}

describe("TextMateSymbolExtractor", () => {
  let extractor: TextMateSymbolExtractor;

  beforeEach(() => {
    resetExtractorCachesForTesting();
    resetLoadedLanguagesForTesting();
    extractor = new TextMateSymbolExtractor();
  });

  afterEach(() => {
    resetExtractorCachesForTesting();
    resetLoadedLanguagesForTesting();
  });

  it("extracts function/class/interface/type/enum from typescript.fix.ts", async () => {
    const content = loadFixture("typescript.fix.ts");
    const artifacts = await extractor.extract({
      path: "typescript.fix.ts",
      content,
    });
    expect(summarise(artifacts)).toEqual([
      { kind: "function", name: "topLevelFn", startLine: 4 },
      { kind: "function", name: "asyncWorker", startLine: 8 },
      { kind: "function", name: "genericId", startLine: 12 },
      { kind: "class", name: "WidgetService", startLine: 16 },
      { kind: "function", name: "doSomething", startLine: 23 },
      { kind: "interface", name: "Widget", startLine: 28 },
      { kind: "type", name: "WidgetSummary", startLine: 33 },
      { kind: "enum", name: "WidgetStatus", startLine: 35 },
      { kind: "namespace", name: "WidgetUtilities", startLine: 40 },
      { kind: "function", name: "describe", startLine: 41 },
    ]);
    for (const a of artifacts) expect(a.language).toBe("typescript");
  });

  it("extracts component, hook, class, type, enum from tsx.fix.tsx", async () => {
    const content = loadFixture("tsx.fix.tsx");
    const artifacts = await extractor.extract({
      path: "tsx.fix.tsx",
      content,
    });
    expect(summarise(artifacts)).toEqual([
      { kind: "interface", name: "ButtonProps", startLine: 4 },
      { kind: "function", name: "Button", startLine: 9 },
      { kind: "function", name: "useToggle", startLine: 13 },
      { kind: "class", name: "Counter", startLine: 17 },
      { kind: "function", name: "increment", startLine: 20 },
      { kind: "type", name: "CounterRef", startLine: 25 },
      { kind: "enum", name: "Variant", startLine: 27 },
    ]);
    for (const a of artifacts) expect(a.language).toBe("tsx");
  });

  it("extracts function/class/arrow names from javascript.fix.js", async () => {
    const content = loadFixture("javascript.fix.js");
    const artifacts = await extractor.extract({
      path: "javascript.fix.js",
      content,
    });
    expect(summarise(artifacts)).toEqual([
      { kind: "function", name: "greet", startLine: 4 },
      { kind: "function", name: "loadData", startLine: 8 },
      { kind: "class", name: "Account", startLine: 12 },
      { kind: "function", name: "describe", startLine: 17 },
      { kind: "function", name: "arrowAdd", startLine: 22 },
      { kind: "function", name: "arrowMul", startLine: 23 },
      { kind: "function", name: "multiply", startLine: 23 },
    ]);
    for (const a of artifacts) expect(a.language).toBe("javascript");
  });

  it("extracts def/class and ignores decorator usages from python.fix.py", async () => {
    const content = loadFixture("python.fix.py");
    const artifacts = await extractor.extract({
      path: "python.fix.py",
      content,
    });
    expect(summarise(artifacts)).toEqual([
      { kind: "function", name: "hello", startLine: 7 },
      { kind: "function", name: "fetch_remote", startLine: 11 },
      { kind: "function", name: "with_long_signature", startLine: 15 },
      { kind: "function", name: "decorator_factory", startLine: 23 },
      { kind: "function", name: "actual_decorator", startLine: 24 },
      // Line 30 is `@decorator_factory("greeting")` — a decorator usage,
      // correctly excluded by the `meta.function.decorator` filter.
      { kind: "function", name: "decorated", startLine: 31 },
      { kind: "class", name: "Account", startLine: 35 },
      { kind: "function", name: "describe", startLine: 39 },
      { kind: "class", name: "Frozen", startLine: 43 },
    ]);
    for (const a of artifacts) expect(a.language).toBe("python");
  });

  it("extracts func/method declarations from go.fix.go (types are limited)", async () => {
    // The Go TextMate grammar uses `entity.name.type.go` for every `type`
    // declaration without distinguishing struct / interface / alias. ADR-017
    // D2 maps only specific subtypes to `ArtifactKind`s, so Go type
    // declarations (Widget, Greeter, Status) are NOT in the inventory until
    // M4 introduces a more precise extractor.
    //
    // Go's grammar also tags interface method declarations and dotted-package
    // function calls (`errors.New`) and builtins (`len`) with the same
    // `entity.name.function.support.go` scope. The filter excludes the
    // `.support.` qualifier to keep call sites out, at the cost of also
    // dropping interface method declarations. This trade-off is documented
    // in ADR-017 D2 (TextMate is a discovery tool, not an authoring one).
    const content = loadFixture("go.fix.go");
    const artifacts = await extractor.extract({
      path: "go.fix.go",
      content,
    });
    expect(summarise(artifacts)).toEqual([
      { kind: "function", name: "New", startLine: 16 },
      { kind: "function", name: "Greet", startLine: 20 },
      { kind: "function", name: "Describe", startLine: 24 },
      { kind: "function", name: "process", startLine: 35 },
    ]);
    for (const a of artifacts) expect(a.language).toBe("go");
  });

  it("extracts fn/struct/enum/trait/impl from rust.fix.rs", async () => {
    const content = loadFixture("rust.fix.rs");
    const artifacts = await extractor.extract({
      path: "rust.fix.rs",
      content,
    });
    expect(summarise(artifacts)).toEqual([
      { kind: "class", name: "Widget", startLine: 4 },
      { kind: "enum", name: "Status", startLine: 9 },
      { kind: "interface", name: "Greeter", startLine: 14 },
      { kind: "function", name: "greet", startLine: 15 },
      { kind: "function", name: "new", startLine: 19 },
      { kind: "function", name: "describe", startLine: 23 },
      { kind: "function", name: "greet", startLine: 29 },
      { kind: "function", name: "standalone", startLine: 34 },
      { kind: "function", name: "async_fetch", startLine: 38 },
    ]);
    for (const a of artifacts) expect(a.language).toBe("rust");
  });

  it("extracts module/class/def from ruby.fix.rb (incl. self.method)", async () => {
    const content = loadFixture("ruby.fix.rb");
    const artifacts = await extractor.extract({
      path: "ruby.fix.rb",
      content,
    });
    expect(summarise(artifacts)).toEqual([
      { kind: "namespace", name: "Widgets", startLine: 4 },
      { kind: "class", name: "Widget", startLine: 5 },
      { kind: "function", name: "initialize", startLine: 8 },
      { kind: "function", name: "describe", startLine: 13 },
      { kind: "function", name: "self.build", startLine: 17 },
      { kind: "class", name: "FrozenWidget", startLine: 22 },
      { kind: "function", name: "self.greet", startLine: 25 },
      { kind: "function", name: "top_level_helper", startLine: 30 },
    ]);
    for (const a of artifacts) expect(a.language).toBe("ruby");
  });

  it("emits no symbols for markdown.fix.md (file-level only)", async () => {
    const content = loadFixture("markdown.fix.md");
    const artifacts = await extractor.extract({
      path: "markdown.fix.md",
      content,
    });
    expect(artifacts).toEqual([]);
  });

  it("emits no symbols for unknown.fix.xyz (degraded path)", async () => {
    // .xyz has no entry in the language map; ADR-017 D3 says unknown
    // languages degrade to file-level entries (the file-level entry itself
    // is synthesised by the Phase 2 service, not the extractor).
    const content = loadFixture("unknown.fix.xyz");
    const artifacts = await extractor.extract({
      path: "unknown.fix.xyz",
      content,
    });
    expect(artifacts).toEqual([]);
  });

  it("returns [] and never throws on pathological input", async () => {
    // Random bytes, deeply nested templates, malformed source — all should
    // produce [] without throwing per the SymbolExtractor contract.
    const random = Array.from({ length: 4096 }, (_, i) =>
      String.fromCharCode((i * 31 + 7) % 0x7f),
    ).join("");
    const inputs = [
      { path: "garbage.ts", content: random },
      { path: "garbage.py", content: " bad bytes" },
      {
        path: "deep.ts",
        content: "`".repeat(200) + "${" + "`a${`b`}`".repeat(50) + "}",
      },
      { path: "trailing.ts", content: "function broken( {" },
    ];
    for (const input of inputs) {
      const result = await extractor.extract(input);
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it("supports() recognises known extensions and rejects unknown ones", () => {
    expect(extractor.supports(".ts")).toBe(true);
    expect(extractor.supports(".TSX")).toBe(true);
    expect(extractor.supports(".py")).toBe(true);
    expect(extractor.supports(".go")).toBe(true);
    expect(extractor.supports(".rs")).toBe(true);
    expect(extractor.supports(".rb")).toBe(true);
    expect(extractor.supports(".md")).toBe(true);
    expect(extractor.supports(".xyz")).toBe(false);
    expect(extractor.supports("")).toBe(false);
  });

  it("declares the supported language list", () => {
    expect(extractor.languages).toContain("typescript");
    expect(extractor.languages).toContain("python");
    expect(extractor.languages).toContain("rust");
    expect(extractor.name).toBe("textmate-shiki");
  });

  it("is lazy: parsing python.fix.py does not load the rust grammar", async () => {
    expect(loadedLanguages()).toEqual([]);
    await extractor.extract({
      path: "python.fix.py",
      content: loadFixture("python.fix.py"),
    });
    const after = loadedLanguages();
    expect(after).toContain("python");
    expect(after).not.toContain("rust");
    expect(after).not.toContain("go");
    expect(after).not.toContain("typescript");
  });

  it("memoises grammar loads across repeated calls", async () => {
    const content = loadFixture("typescript.fix.ts");
    await extractor.extract({ path: "a.ts", content });
    const afterFirst = loadedLanguages();
    await extractor.extract({ path: "b.ts", content });
    expect(loadedLanguages()).toEqual(afterFirst);
  });
});
