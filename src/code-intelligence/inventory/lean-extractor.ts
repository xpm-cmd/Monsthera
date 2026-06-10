/**
 * `LeanSymbolExtractor` — regex line-scan extractor for Lean 4 sources.
 *
 * Why not the TextMate route: a grammar would tokenize declaration names,
 * but composing fully-qualified names still requires a per-file
 * `namespace … end` state machine (TextMate tokenizes, it does not nest).
 * The anchored-regex scan below delivers correct FQNs with strictly less
 * machinery, in line with ADR-017's "lightweight inventory, regex is fine"
 * philosophy.
 *
 * Semantics mirror the Banyan corpus validators' reference parser
 * (`leanparse.py`):
 *   - Only top-level (column-0) declarations are extracted.
 *   - `--` line comments and *nested* `/- … -/` block comments are
 *     ignored; lines that start inside a block comment never match.
 *   - `namespace Foo` pushes onto a stack; `end Foo` pops only when the
 *     name matches the top of the stack (bare `end` — e.g. closing a
 *     `section` — never pops). `section`/`open`/`variable` lines do not
 *     affect naming.
 *   - Declaration names follow `[A-Za-z_][A-Za-z0-9_.']*` (dots and primes
 *     allowed), optionally prefixed by `noncomputable` / `private`.
 *   - String literals are deliberately not comment-aware — an accepted
 *     limitation, validated against the real corpus by the reference
 *     implementation's consumers.
 *
 * Symbol-kind mapping (Lean keyword → existing `SymbolKind`; the enum is
 * NOT widened — every Lean declaration maps onto an existing kind):
 *
 *   | Lean keyword       | kind        | rationale                                |
 *   | ------------------ | ----------- | ---------------------------------------- |
 *   | `theorem`          | `function`  | proved term-level declaration            |
 *   | `lemma`            | `function`  | synonym of `theorem`                     |
 *   | `def`              | `function`  | term/function definition                 |
 *   | `instance` (named) | `function`  | elaborated like `def`; anonymous         |
 *   |                    |             | instances have no name and are skipped   |
 *   | `abbrev`           | `type`      | reducible alias (type-synonym idiom)     |
 *   | `structure`        | `record`    | Lean structures are record types         |
 *   | `inductive`        | `enum`      | inductive datatypes generalise enums     |
 *   | `namespace`        | `namespace` | direct                                   |
 *
 * Artifacts carry the FQN in `name` (so both bare and namespace-qualified
 * queries hit) and the namespace prefix in `scope`.
 */

import * as path from "node:path";

import type { Logger } from "../../core/logger.js";

import type { SymbolExtractor } from "./extractor.js";
import type { CodeArtifact, SymbolKind } from "./types.js";

const LEAN_EXTENSION = ".lean";
const LEAN_LANGUAGE_ID = "lean";

/**
 * Mirrors leanparse.py's `_DECL_RE`: optional `noncomputable` / `private`
 * modifiers, a declaration keyword, then an optional name. A keyword with
 * no extractable name (anonymous `instance : …`) matches but yields no
 * symbol — exactly like the reference, which records `name=None`.
 */
const DECL_RE =
  /^(?:noncomputable\s+|private\s+)*(theorem|lemma|def|abbrev|structure|inductive|instance)(?:\s+([A-Za-z_][A-Za-z0-9_.']*))?/;

const NAMESPACE_LINE_RE = /^namespace\b/;
const END_LINE_RE = /^end\b/;

const KIND_BY_KEYWORD: Readonly<Record<string, SymbolKind>> = {
  theorem: "function",
  lemma: "function",
  def: "function",
  instance: "function",
  abbrev: "type",
  structure: "record",
  inductive: "enum",
};

/**
 * Block-comment nesting depth at the START of each line. Mirrors
 * leanparse.py's `_comment_depth_per_line`: `--` at depth 0 silences the
 * rest of the line; `/-` opens at any depth (nesting); `-/` closes only
 * when depth > 0 (stray closers are inert).
 */
function commentDepthPerLine(lines: readonly string[]): number[] {
  const depths: number[] = new Array<number>(lines.length);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    depths[i] = depth;
    const line = lines[i] ?? "";
    let j = 0;
    while (j < line.length - 1) {
      const two = line.slice(j, j + 2);
      if (depth === 0 && two === "--") break; // line comment: rest is inert
      if (two === "/-") {
        depth += 1;
        j += 2;
        continue;
      }
      if (depth > 0 && two === "-/") {
        depth -= 1;
        j += 2;
        continue;
      }
      j += 1;
    }
  }
  return depths;
}

function makeLeanArtifact(input: {
  kind: SymbolKind;
  fqn: string;
  scope: string | undefined;
  filePath: string;
  startLine: number;
}): CodeArtifact {
  return {
    id: `${input.kind}:${input.filePath}:${input.fqn}@${input.startLine}`,
    kind: input.kind,
    name: input.fqn,
    path: input.filePath,
    language: LEAN_LANGUAGE_ID,
    startLine: input.startLine,
    endLine: input.startLine,
    ...(input.scope !== undefined && { scope: input.scope }),
  };
}

export class LeanSymbolExtractor implements SymbolExtractor {
  readonly name = "lean-regex";
  readonly languages: readonly string[] = [LEAN_LANGUAGE_ID];

  constructor(private readonly logger?: Logger) {}

  supports(extension: string): boolean {
    return extension.toLowerCase() === LEAN_EXTENSION;
  }

  async extract(input: {
    readonly path: string;
    readonly content: string;
  }): Promise<readonly CodeArtifact[]> {
    const { path: filePath, content } = input;
    if (!this.supports(path.extname(filePath))) return [];

    try {
      return this.scan(filePath, content);
    } catch (cause) {
      this.logger?.debug("lean extractor failed", {
        path: filePath,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return [];
    }
  }

  private scan(filePath: string, content: string): readonly CodeArtifact[] {
    const artifacts: CodeArtifact[] = [];
    const lines = content.split(/\r?\n/);
    const depths = commentDepthPerLine(lines);
    const nsStack: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if ((depths[i] ?? 0) > 0) continue; // line starts inside a block comment
      const line = (lines[i] ?? "").trimEnd();
      const startLine = i + 1;

      const declMatch = line.match(DECL_RE);
      if (declMatch) {
        const keyword = declMatch[1] ?? "";
        const declName = declMatch[2];
        const kind = KIND_BY_KEYWORD[keyword];
        if (declName && kind) {
          const scope = nsStack.length > 0 ? nsStack.join(".") : undefined;
          const fqn = scope !== undefined ? `${scope}.${declName}` : declName;
          artifacts.push(makeLeanArtifact({ kind, fqn, scope, filePath, startLine }));
        }
        continue;
      }

      if (NAMESPACE_LINE_RE.test(line)) {
        // Mirror the reference: whitespace-split, take the second token
        // verbatim (`namespace Foo.Bar` pushes "Foo.Bar" as one element;
        // a matching `end Foo.Bar` pops it).
        const segment = line.split(/\s+/)[1];
        if (segment) {
          const scope = nsStack.length > 0 ? nsStack.join(".") : undefined;
          nsStack.push(segment);
          artifacts.push(
            makeLeanArtifact({
              kind: "namespace",
              fqn: nsStack.join("."),
              scope,
              filePath,
              startLine,
            }),
          );
        }
        continue;
      }

      if (END_LINE_RE.test(line)) {
        const segment = line.split(/\s+/)[1];
        if (segment && nsStack.length > 0 && nsStack[nsStack.length - 1] === segment) {
          nsStack.pop();
        }
      }
    }

    return artifacts;
  }
}
