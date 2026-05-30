# Corpus Data Hygiene (PR1 / P0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a dirty knowledge-article tag impossible to persist from any entry point (T1), and surface the historical dirty-tag backlog via a non-gating lint rule (T2).

**Architecture:** Tags are normalized at the Zod validation boundary (`CreateArticleInputSchema` / `UpdateArticleInputSchema`), which is the single chokepoint every caller (CLI, MCP, batch) already flows through via `validateCreateInput` / `validateUpdateInput`. A new pure `normalizeTags`/`normalizeTag` module is the shared definition of "the same tag", reused by a new corpus lint rule `tag_near_duplicate` (severity `warning`, new `tag-hygiene` registry family) that flags per-article tag lists whose entries collapse to one normalized key. The markdown read-parser (`parseValue`) is deliberately left untouched to avoid churning unrelated edits (the T1↔T5 precedence: normalize on write-input only; clean the backlog with a deliberate pass later).

**Tech Stack:** TypeScript (ESM, Node ≥22), Zod v4 (`zod/v4`), Vitest, run-current-source via `pnpm exec tsx src/bin.ts`. Package manager: pnpm.

---

## Process guardrails (apply to EVERY task)

- **Read the exact bytes of a file before every Edit.** `old_string` must be copied from the real file, never assumed.
- **TDD red→green:** write the failing test, run it, SEE it fail for the right reason, then implement.
- **Verify the real artifact:** after wiring, run the actual CLI and inspect the bytes on disk — not just the unit test.
- **Run current source:** `pnpm exec tsx src/bin.ts <cmd>` (the global `monsthera` binary is version-drifted — never use it).
- **Bash stdout can drop:** prefer single non-hanging commands; if output matters, redirect to a file and `Read` it. macOS has no `timeout` binary.
- **Per-commit gate:** `pnpm typecheck` (0 errors — vitest passing does NOT imply types check) · `pnpm lint` (0) · `pnpm test` (report the REAL pass count) · `pnpm exec tsx src/bin.ts lint` exits 0.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push or open a PR until the user asks.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/knowledge/tags.ts` | Pure tag-normalization helpers (`normalizeTag`, `normalizeTags`). The single definition of "same tag". | **Create** |
| `tests/unit/knowledge/tags.test.ts` | Unit tests for the normalizer. | **Create** |
| `src/knowledge/schemas.ts` | Wire `.transform(normalizeTags)` onto `tags` in create + update input schemas. | Modify (`:1-4` imports, `:21`, `:53`) |
| `tests/unit/knowledge/schemas.test.ts` | Prove `validateCreateInput`/`validateUpdateInput` normalize tags. | Modify (append describe block) |
| `tests/unit/knowledge/service.test.ts` | Prove end-to-end: `createArticle`/`updateArticle` return clean tags. | Modify (append tests) |
| `src/work/lint.ts` | New `TagNearDuplicateFinding`, `LintRegistry` += `"tag-hygiene"`, `scanTagNearDuplicates`, wire into `scanCorpus`. | Modify (`:1-6`, `:124-131`, `:136`, `:225-301`) |
| `src/cli/lint-commands.ts` | `VALID_REGISTRIES` += `"tag-hygiene"`, `formatFinding` case, help text. | Modify (`:16-21`, `:44-47`, `:64-67`, `:240-272`) |
| `tests/unit/work/lint-anti-examples.test.ts` | New describe block for `tag_near_duplicate` (reuses `writeTaggedArticle` at `:224`). | Modify (append describe block) |

---

## Task 0: Clean the worktree and branch

**Files:** none (git + filesystem only).

- [ ] **Step 1: Confirm the stray file is untracked and not in any commit**

Run:
```bash
git status --porcelain knowledge/notes/security-review-dashboard-http-extraction-httpts-is-a-clean-pure-move.md
git clean -n -- knowledge/notes/
```
Expected: the status line is prefixed `??` (untracked); `git clean -n` lists the file as `Would remove ...`.

- [ ] **Step 2: Remove the stray review note**

Run:
```bash
rm "knowledge/notes/security-review-dashboard-http-extraction-httpts-is-a-clean-pure-move.md"
```
Expected: no output; `git status --porcelain` no longer lists it.

- [ ] **Step 3: Create the feature branch**

Run:
```bash
git checkout -b fix/corpus-data-hygiene
```
Expected: `Switched to a new branch 'fix/corpus-data-hygiene'`.

---

## Task 1: `normalizeTags` / `normalizeTag` pure helper

**Files:**
- Create: `src/knowledge/tags.ts`
- Test: `tests/unit/knowledge/tags.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/knowledge/tags.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizeTag, normalizeTags } from "../../../src/knowledge/tags.js";

describe("normalizeTag", () => {
  it("strips a single surrounding quote pair", () => {
    expect(normalizeTag("'family:kriging'")).toBe("family:kriging");
    expect(normalizeTag('"family:kriging"')).toBe("family:kriging");
  });

  it("trims and collapses internal whitespace runs", () => {
    expect(normalizeTag("  machine   learning ")).toBe("machine learning");
  });

  it("leaves an already-clean tag unchanged", () => {
    expect(normalizeTag("family:kriging")).toBe("family:kriging");
  });

  it("returns empty string for empty / quote-only input", () => {
    expect(normalizeTag("''")).toBe("");
    expect(normalizeTag("   ")).toBe("");
  });
});

describe("normalizeTags", () => {
  it("dedupes quote/whitespace variants that collapse to one value", () => {
    expect(
      normalizeTags(["'family:kriging'", "family:kriging", " family:kriging "]),
    ).toEqual(["family:kriging"]);
  });

  it("dedupes case-variants, preserving the first-seen casing", () => {
    expect(normalizeTags(["Kriging", "kriging"])).toEqual(["Kriging"]);
  });

  it("drops empties and preserves first-seen order", () => {
    expect(normalizeTags(["", "beta", "alpha", "beta"])).toEqual(["beta", "alpha"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/knowledge/tags.test.ts`
Expected: FAIL — cannot resolve `../../../src/knowledge/tags.js` (module not created yet).

- [ ] **Step 3: Write the implementation**

Create `src/knowledge/tags.ts`:
```ts
/**
 * Tag normalization — the single definition of "the same tag" shared by the
 * write path (Zod transform in schemas.ts) and the audit path (the
 * tag_near_duplicate lint rule). Keeping one implementation means detection
 * and prevention can never disagree about what counts as a duplicate.
 */

/**
 * Clean a single tag:
 *  - trim surrounding whitespace
 *  - strip a single matching pair of surrounding quotes ('...' or "...")
 *  - collapse internal whitespace runs to one space
 *
 * Returns "" when nothing survives (caller drops empties).
 */
export function normalizeTag(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  return s.replace(/\s+/g, " ");
}

/**
 * Normalize a tag list so a dirty tag cannot reach disk: clean each tag, drop
 * empties, and dedupe by a case-folded key while preserving the first-seen
 * tag's original casing. Order-preserving (first occurrence wins).
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const cleaned = normalizeTag(raw);
    if (cleaned === "") continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/knowledge/tags.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/tags.ts tests/unit/knowledge/tags.test.ts
git commit -m "feat(knowledge): add pure tag normalizer (trim, dequote, dedupe)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Wire the normalizer into the write-path schemas

**Files:**
- Modify: `src/knowledge/schemas.ts` (import; `:21` create tags; `:53`-equivalent update tags)
- Test: `tests/unit/knowledge/schemas.test.ts` (append), `tests/unit/knowledge/service.test.ts` (append)

- [ ] **Step 1: Write the failing schema tests**

Append to `tests/unit/knowledge/schemas.test.ts` (after the final `describe` block, before EOF):
```ts
// ─── 7. Tag normalization on the write path ──────────────────────────────────

describe("tag normalization", () => {
  it("normalizes tags in CreateArticleInputSchema (dequote + dedupe)", () => {
    const result = CreateArticleInputSchema.safeParse({
      ...validCreateInput,
      tags: ["'family:kriging'", "family:kriging", " family:kriging "],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(["family:kriging"]);
    }
  });

  it("normalizes tags in UpdateArticleInputSchema and preserves first-seen casing", () => {
    const result = UpdateArticleInputSchema.safeParse({ tags: ["Kriging", "kriging"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(["Kriging"]);
    }
  });

  it("validateCreateInput returns normalized tags", () => {
    const result = validateCreateInput({
      ...validCreateInput,
      tags: ["'a'", "a", ""],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tags).toEqual(["a"]);
    }
  });

  it("still defaults tags to [] when omitted (transform does not break default)", () => {
    const { tags: _tags, ...withoutTags } = validCreateInput;
    const result = validateCreateInput(withoutTags);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tags).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/knowledge/schemas.test.ts`
Expected: FAIL — the first three new tests fail (tags returned verbatim with quotes/dupes); the "defaults to []" test passes. (Failure confirms tags are not yet normalized.)

- [ ] **Step 3: Wire the transform**

In `src/knowledge/schemas.ts`, add the import after line 4 (`import { ValidationError } from "../core/errors.js";`):
```ts
import { normalizeTags } from "./tags.js";
```

Change the `tags` line in `CreateArticleInputSchema` (currently `  tags: z.array(z.string()).default([]),`) to:
```ts
  tags: z.array(z.string()).transform(normalizeTags).default([]),
```

Change the `tags` line in `UpdateArticleInputSchema` (currently `  tags: z.array(z.string()).optional(),`) to:
```ts
  tags: z.array(z.string()).transform(normalizeTags).optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/knowledge/schemas.test.ts`
Expected: PASS (all, including the prior "defaults tags to []" and "extra properties are stripped" tests).

- [ ] **Step 5: Write the failing service-level test**

Append to `tests/unit/knowledge/service.test.ts` inside the existing `describe("createArticle", ...)` block (after the last `it` in that block, before its closing `});`):
```ts
  it("persists normalized tags (dequote + dedupe) end-to-end", async () => {
    const result = await service.createArticle({
      ...validCreateInput,
      tags: ["'family:kriging'", "family:kriging", " family:kriging "],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tags).toEqual(["family:kriging"]);
  });
```

And append inside the existing `describe("updateArticle", ...)` block (after its last `it`, before its closing `});`):
```ts
  it("normalizes tags supplied on update", async () => {
    const article = await seedArticle(service);
    const result = await service.updateArticle(article.id, { tags: ["Kriging", "kriging"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tags).toEqual(["Kriging"]);
  });
```

- [ ] **Step 6: Run the service tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/knowledge/service.test.ts`
Expected: PASS (transform already wired in Step 3, so these pass immediately — they lock the end-to-end behavior through the service that both CLI and MCP call).

- [ ] **Step 7: Real-artifact verification (CLI write to disk)**

Run (writes into the repo's own `knowledge/` store; uses a throwaway title):
```bash
pnpm exec tsx src/bin.ts knowledge create \
  --title "ZZZ Tag Normalize Smoke" --category context \
  --content "smoke test" --tags "'family:kriging', family:kriging,  family:kriging " \
  > /tmp/t1-create.txt 2>&1; echo "exit=$?"
```
Then read the created file's frontmatter:
```bash
grep -RHn '^tags:' knowledge/notes/zzz-tag-normalize-smoke.md
```
Expected: `exit=0` and the line reads exactly `tags: [family:kriging]` (single clean tag — no quotes, no duplicates).

- [ ] **Step 8: Delete the smoke article (leave the corpus clean)**

```bash
pnpm exec tsx src/bin.ts knowledge get zzz-tag-normalize-smoke > /tmp/t1-id.txt 2>&1
# read the id (k-...) from /tmp/t1-id.txt, then:
pnpm exec tsx src/bin.ts knowledge delete <k-id-from-output>
```
Expected: `Deleted knowledge article: <k-id>`; `git status` shows no leftover note.

- [ ] **Step 9: Commit**

```bash
git add src/knowledge/schemas.ts tests/unit/knowledge/schemas.test.ts tests/unit/knowledge/service.test.ts
git commit -m "feat(knowledge): normalize tags on the write path via schema transform

Single chokepoint: CLI, MCP, and batch all flow through validateCreate/UpdateInput.
parseValue (read path) intentionally untouched to avoid churning unrelated edits.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `tag_near_duplicate` lint rule in the scanner

**Files:**
- Modify: `src/work/lint.ts` (import `:1-6`; finding type + union `:124-131`; `LintRegistry` `:136`; `scanCorpus` `:225-301`; new function)
- Test: `tests/unit/work/lint-anti-examples.test.ts` (append describe block)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/work/lint-anti-examples.test.ts` (after the final `describe` block; reuses the existing `writeTaggedArticle` helper at line 224). Also add `TagNearDuplicateFinding` to the type import at the top (`import type { PhraseAntiExampleFinding, TokenDriftFinding, TagNearDuplicateFinding } from "../../../src/work/lint.js";`):
```ts
describe("scanCorpus — tag-hygiene (tag_near_duplicate)", () => {
  let root: string;
  let notesDir: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `monsthera-lint-tags-${randomUUID()}`);
    notesDir = path.join(root, "notes");
    await fs.mkdir(notesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("flags an article whose tags collapse to one normalized key", async () => {
    await writeTaggedArticle(notesDir, "split", ["'family:kriging'", "family:kriging"], "Body.");
    const res = await scanCorpus({ markdownRoot: root, canonicalValues: [] });
    const finding = res.findings.find(
      (f): f is TagNearDuplicateFinding => f.rule === "tag_near_duplicate",
    );
    expect(finding).toBeDefined();
    expect(finding?.normalized).toBe("family:kriging");
    expect(finding?.severity).toBe("warning");
    expect(res.warningCount).toBe(1);
    expect(res.errorCount).toBe(0); // warning must not gate the exit code
  });

  it("does not flag a clean, distinct tag set (control)", async () => {
    await writeTaggedArticle(notesDir, "clean", ["family:kriging", "method:idw"], "Body.");
    const res = await scanCorpus({ markdownRoot: root, canonicalValues: [] });
    expect(res.findings.some((f) => f.rule === "tag_near_duplicate")).toBe(false);
  });

  it("skips an article tagged lint-exempt", async () => {
    await writeTaggedArticle(notesDir, "doc", ["lint-exempt", "'a'", "a"], "Body.");
    const res = await scanCorpus({ markdownRoot: root, canonicalValues: [] });
    expect(res.findings.some((f) => f.rule === "tag_near_duplicate")).toBe(false);
  });

  it("runs only under registry all / tag-hygiene", async () => {
    await writeTaggedArticle(notesDir, "split", ["'a'", "a"], "Body.");
    const off = await scanCorpus({ markdownRoot: root, registry: "canonical-values", canonicalValues: [] });
    expect(off.findings.some((f) => f.rule === "tag_near_duplicate")).toBe(false);
    const on = await scanCorpus({ markdownRoot: root, registry: "tag-hygiene", canonicalValues: [] });
    expect(on.findings.some((f) => f.rule === "tag_near_duplicate")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/work/lint-anti-examples.test.ts`
Expected: FAIL — `TagNearDuplicateFinding` is not exported (type import error) and no `tag_near_duplicate` findings are produced.

- [ ] **Step 3: Add the finding type and extend the union/registry**

In `src/work/lint.ts`, add the import after line 6 (`import type { AntiExamplePhrase, AntiExampleToken, CanonicalValue } from "./policy-loader.js";`):
```ts
import { normalizeTag } from "../knowledge/tags.js";
```

Add this type immediately before `export type LintFinding =` (line 124):
```ts
/**
 * Tag near-duplicate finding: an article's frontmatter `tags` contains 2+ raw
 * entries that collapse to the same normalized key (differing by surrounding
 * quotes, case, or whitespace — or exact duplicates). Warning, not error:
 * this is corpus hygiene, not a correctness failure, and must not gate the
 * `monsthera lint` exit code that the pre-commit hook depends on. The write
 * path (normalizeTags in schemas.ts) prevents NEW dirty tags; this rule
 * surfaces the historical backlog already on disk.
 */
export type TagNearDuplicateFinding = {
  readonly file: string;
  readonly severity: "warning";
  readonly rule: "tag_near_duplicate";
  readonly normalized: string;
  readonly variants: readonly string[];
};
```

Add `| TagNearDuplicateFinding` to the `LintFinding` union (after `| PlanningSectionTamperedFinding;`):
```ts
export type LintFinding =
  | CanonicalValueMismatchFinding
  | OrphanCitationFinding
  | TokenDriftFinding
  | PhraseAntiExampleFinding
  | CitationValueMismatchFinding
  | VerifyDensityFinding
  | PlanningSectionTamperedFinding
  | TagNearDuplicateFinding;
```

Change `LintRegistry` (line 136) to add the family:
```ts
export type LintRegistry = "canonical-values" | "anti-examples" | "planning-hash" | "tag-hygiene" | "all";
```

- [ ] **Step 4: Wire the rule into `scanCorpus`**

In `scanCorpus`, after the line `const runPlanningHash = registry === "all" || registry === "planning-hash";` (line 230) add:
```ts
  const runTagHygiene = registry === "all" || registry === "tag-hygiene";
```

Inside the per-file loop, after the `if (runPlanningHash && dir === WORK_DIR) { ... }` block (ends line 299) and before the loop's closing braces, add:
```ts
      if (runTagHygiene && !isLintExempt) {
        findings.push(...scanTagNearDuplicates(parsed.value.frontmatter, relFile));
      }
```

Add the implementation function (place it next to the other scan helpers, e.g. after `scanPlanningHash` near line 679):
```ts
/**
 * Flag tag lists whose entries collapse to the same normalized key. One
 * finding per duplicated key, listing the raw variants. Reuses normalizeTag
 * (the write-path normalizer) so detection and prevention agree on identity.
 */
function scanTagNearDuplicates(
  frontmatter: Record<string, unknown>,
  file: string,
): readonly TagNearDuplicateFinding[] {
  const raw = frontmatter["tags"];
  const tags = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
  if (tags.length < 2) return [];

  const groups = new Map<string, string[]>();
  for (const tag of tags) {
    const cleaned = normalizeTag(tag);
    if (cleaned === "") continue;
    const key = cleaned.toLowerCase();
    const variants = groups.get(key);
    if (variants) variants.push(tag);
    else groups.set(key, [tag]);
  }

  const findings: TagNearDuplicateFinding[] = [];
  for (const [key, variants] of groups) {
    if (variants.length >= 2) {
      findings.push({
        file,
        severity: "warning",
        rule: "tag_near_duplicate",
        normalized: key,
        variants: [...variants],
      });
    }
  }
  return findings;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/work/lint-anti-examples.test.ts`
Expected: PASS (all existing + 4 new tag-hygiene tests).

- [ ] **Step 6: Typecheck (proves the union is consistent everywhere except the CLI formatter, which Task 4 fixes)**

Run: `pnpm typecheck`
Expected: FAIL with one error in `src/cli/lint-commands.ts` — `formatFinding`'s `switch` is not exhaustive (missing `tag_near_duplicate`). This is the type system telling us Task 4 is required. (If typecheck passes here, the union wasn't actually extended — investigate.)

- [ ] **Step 7: Commit**

```bash
git add src/work/lint.ts tests/unit/work/lint-anti-examples.test.ts
git commit -m "feat(lint): add tag_near_duplicate rule (tag-hygiene family, warning)

Per-article: flags tag lists whose entries collapse to one normalized key.
Reuses normalizeTag so detection matches the write-path normalizer.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(Commit even though typecheck is red — the CLI formatter in Task 4 completes the union handling. Alternatively, defer this commit and combine with Task 4. Default: defer the commit; do Task 4 first, then commit Tasks 3+4 together so no commit leaves `main` un-typecheckable. **Chosen: defer — do not run this Step 7 commit; commit at Task 4 Step 5.**)

---

## Task 4: CLI registry validation + formatter for the new rule

**Files:**
- Modify: `src/cli/lint-commands.ts` (`VALID_REGISTRIES` `:16-21`; help text `:44-47` and `:64-67`; `formatFinding` `:240-272`)

- [ ] **Step 1: Add the family to the validator and help text**

In `src/cli/lint-commands.ts`, change `VALID_REGISTRIES` (lines 16-21) to include the new family:
```ts
const VALID_REGISTRIES: readonly LintRegistry[] = [
  "canonical-values",
  "anti-examples",
  "planning-hash",
  "tag-hygiene",
  "all",
];
```

Update the `--registry` help description (line ~45-46) to mention it:
```ts
        {
          name: "--registry <name>",
          description:
            "Which registry family to apply: canonical-values, anti-examples, planning-hash, tag-hygiene, or all (default).",
        },
```

Update the warnings note (line ~66) so the new warning is documented:
```ts
        "Orphan citations, verify_density_exceeded, and tag_near_duplicate are warnings and do not affect exit code.",
```

- [ ] **Step 2: Add the formatter case**

In `formatFinding` (the `switch (f.rule)` ending at line 271), add this case before the closing `}` of the switch:
```ts
    case "tag_near_duplicate": {
      const variants = f.variants.map((v) => JSON.stringify(v)).join(", ");
      return `${prefix}: tag near-duplicate "${f.normalized}" — variants ${variants}`;
    }
```

- [ ] **Step 3: Verify typecheck and lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: both exit 0 (the exhaustive switch is now complete; no unused vars).

- [ ] **Step 4: Real-artifact verification (CLI text + registry selection)**

Run against the real corpus (which contains the historical dirty tags):
```bash
pnpm exec tsx src/bin.ts lint --registry tag-hygiene --format text > /tmp/t2-lint.txt 2>&1; echo "exit=$?"
```
Then `Read /tmp/t2-lint.txt`.
Expected: `exit=0` (warnings do not gate exit). The output contains one or more `WARNING notes/<slug>.md: tag near-duplicate "<key>" — variants ...` lines (the historical split pairs). Confirms the rule fires on real data and the formatter renders.

- [ ] **Step 5: Commit Tasks 3 + 4 together**

```bash
git add src/work/lint.ts src/cli/lint-commands.ts tests/unit/work/lint-anti-examples.test.ts
git commit -m "feat(lint): tag_near_duplicate rule + tag-hygiene registry family + formatter

Warning severity — surfaces the historical dirty-tag backlog without gating
the lint exit code the pre-commit hook depends on.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full verification gate + knowledge note

**Files:**
- Create: a Monsthera knowledge article (category `solution`) via the CLI/MCP — not a repo source edit.

- [ ] **Step 1: Run the complete gate**

Run each and capture output:
```bash
pnpm typecheck > /tmp/gate-typecheck.txt 2>&1; echo "typecheck=$?"
pnpm lint > /tmp/gate-lint.txt 2>&1; echo "lint=$?"
pnpm test > /tmp/gate-test.txt 2>&1; echo "test=$?"
pnpm exec tsx src/bin.ts lint > /tmp/gate-cli-lint.txt 2>&1; echo "cli-lint=$?"
```
`Read` each file. Expected: `typecheck=0`, `lint=0`, `test=0`, `cli-lint=0`. Report the REAL test pass count from `/tmp/gate-test.txt` (e.g. "N passed") — do not fabricate it.

- [ ] **Step 2: Real corpus no-regression check**

```bash
pnpm exec tsx src/bin.ts doctor > /tmp/gate-doctor.txt 2>&1; echo "doctor=$?"
```
`Read /tmp/gate-doctor.txt`. Expected: `doctor=0`; no new errors versus a clean run; stdout begins with `Monsthera Doctor` (confirms #10/T9 is still a non-issue — `doctor` does not emit JSON logs to stdout).

- [ ] **Step 3: Write the knowledge note (repo convention)**

Create a category-`solution` article summarizing what shipped, anchored in the commit SHAs from Tasks 1, 2, and 3+4. Use the CLI (goes through the now-normalizing write path — a nice dogfood):
```bash
pnpm exec tsx src/bin.ts knowledge create \
  --title "PR1: corpus tag-hygiene (write-path normalize + lint rule)" \
  --category solution \
  --tags "monsthera,tags,lint,data-integrity,dogfood" \
  --content-file /tmp/pr1-knowledge-note.md
```
where `/tmp/pr1-knowledge-note.md` documents: the two-bug root cause (write path `parseCommaSeparated`/serialize vs read path `parseValue`), the schema-transform chokepoint decision, the T1↔T5 "write-input only" precedence, the new `tag-hygiene` warning family, and the deliberate non-goals (parseValue untouched). Include the commit SHAs.

- [ ] **Step 4: Confirm and STOP for user checkpoint**

Run: `git log --oneline origin/main..HEAD` (or `git log --oneline -6`) and `git status`.
Expected: 3 commits on `fix/corpus-data-hygiene` (Task 1, Task 2, Task 3+4) plus Task 0's cleanup, clean working tree. **Do not push or open a PR.** Report results to the user and ask how to proceed (push / PR / continue to PR2).

---

## Self-Review (against the design spec)

**Spec coverage:**
- T1 (normalize on write) → Tasks 1–2. Covers CLI + MCP + batch via the shared `validateCreate/UpdateInput` chokepoint. ✓
- T1 non-goals (parseValue untouched, no serialize-normalize) → encoded as explicit decisions in Task 2 commit + knowledge note. ✓
- T2 (audit path) → Tasks 3–4: per-article `tag_near_duplicate`, warning, `tag-hygiene` family, exempt-tag respect, formatter, clean-corpus control test. ✓
- Real-artifact verification → Task 2 Step 7 (grep on-disk frontmatter), Task 4 Step 4 (lint on real corpus). ✓
- Verification gate + knowledge note → Task 5. ✓
- Cleanup of stray file + branch → Task 0. ✓

**Placeholder scan:** No "TBD"/"add error handling"/"similar to" — every code step shows complete code. The knowledge-note body (Task 5 Step 3) is described by required content, written at execution from real SHAs (acceptable: it is prose output, not code). ✓

**Type consistency:** `normalizeTag` / `normalizeTags` names match across `tags.ts`, `schemas.ts`, and `lint.ts`. `TagNearDuplicateFinding` fields (`file`, `severity`, `rule`, `normalized`, `variants`) match between the type definition (Task 3 Step 3), the producer `scanTagNearDuplicates` (Task 3 Step 4), the formatter (Task 4 Step 2), and the test assertions (Task 3 Step 1). `LintRegistry` literal `"tag-hygiene"` matches between `lint.ts` and `VALID_REGISTRIES`. ✓

**Ordering dependency:** Task 1 (tags.ts) must precede Task 2 (schema import) and Task 3 (lint import). Task 3 leaves typecheck red on purpose; Task 4 closes it; commit deferred to Task 4 Step 5 so no commit lands an un-typecheckable tree. ✓
