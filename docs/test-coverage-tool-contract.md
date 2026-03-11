# Structural Test Coverage Tool Contract

This document defines the expected output and heuristics for a future `analyze_test_coverage` MCP tool.

The goal is to make the tool structurally useful without implying runtime coverage, branch coverage, or execution certainty.

## Scope

`analyze_test_coverage` should be a file-level tool in v1.

- Input: one repo-relative `filePath`
- Output: one structural coverage assessment for that file
- Out of scope for v1: directory rollups, repo rollups, percentages, and trend charts

If aggregated rollups are needed later, they should be introduced as a separate ticket with an explicit `scope` contract.

## Output Contract

The tool should return a stable JSON payload with this shape:

```json
{
  "filePath": "src/tools/read-tools.ts",
  "language": "typescript",
  "methodologyVersion": "v1",
  "status": "tested",
  "confidence": "high",
  "matchedTests": [
    {
      "path": "tests/unit/tools/read-tools.test.ts",
      "matchKinds": ["naming", "imports"],
      "notes": "Mirrored path and direct import match."
    }
  ],
  "signals": {
    "namingMatches": 1,
    "importMatches": 1,
    "fallbackMatches": 0
  },
  "limitations": [
    "Structural heuristics only. This is not runtime coverage.",
    "Dynamic imports and indirect execution may be missed."
  ]
}
```

Required fields:

- `filePath`: repo-relative target file
- `language`: detected source language or `null` when unsupported
- `methodologyVersion`: contract version, starting at `v1`
- `status`: one of `tested`, `untested`, `unknown`
- `confidence`: one of `high`, `medium`, `low`
- `matchedTests`: zero or more structural matches
- `signals`: explicit count of which heuristics fired
- `limitations`: always present, never omitted

## Status Semantics

`tested`
- At least one structural match exists with enough evidence to believe the file is intentionally covered by tests.
- A direct import/reference from a test file should usually qualify.
- A strong mirrored naming match can also qualify when it is unambiguous.

`untested`
- The target file is supported and structurally analyzable.
- The tool completed its heuristic search.
- No meaningful test match was found.

`unknown`
- The tool cannot make a responsible structural judgment.
- Examples: unsupported language, generated files, fixture-only files, ambiguous package-level tests, or missing index data needed by the heuristic.

Important rule:

- `untested` means "we looked and found no structural evidence"
- `unknown` means "the tool cannot safely decide"

## Heuristic Strategy

The matching strategy should be explicit and layered.

### 1. Naming Matches

Look for mirrored or conventional test paths such as:

- `src/foo/bar.ts` -> `tests/foo/bar.test.ts`
- `src/foo/bar.ts` -> `tests/foo/bar.spec.ts`
- `src/foo/bar.py` -> `tests/foo/test_bar.py`
- `pkg/foo/bar.go` -> `pkg/foo/bar_test.go`

Naming matches are strong when the stem and relative path both align.

### 2. Import Matches

Look for test files that directly import the target file or its module path.

This should be the highest-confidence signal in TypeScript, JavaScript, and Python.

For Go and Rust, where tests may live in the same package/module, package-level structural relationships may raise confidence but should remain explicit in `notes`.

### 3. Fallback Matches

Fallbacks may raise low-confidence evidence but must never silently promote a file to `tested` on their own.

Examples:

- Co-located test directories with the same stem
- Package-level test files in Go/Rust without direct per-file imports
- Barrel-export tests that only touch the target indirectly

Fallback-only results should usually stay `unknown` or `low` confidence unless another signal strengthens them.

## Confidence Rules

`high`
- Direct import/reference from a test file
- Or direct import plus mirrored naming/path alignment

`medium`
- Strong naming/path alignment without a direct import
- Or package-level evidence that is specific enough to a small target set

`low`
- Weak fallback evidence only
- Low confidence must not be used to report `tested` unless the implementation ticket explicitly proves that case safe

## Limitations

The tool must explain its boundaries every time.

Minimum limitation set:

- Structural heuristics only, not runtime execution coverage
- No line, branch, or statement percentages
- Dynamic imports, reflection, generated code, and framework magic may be missed
- Integration and end-to-end tests may exercise behavior without creating a direct structural match

## Implementation Guardrails

The follow-up implementation ticket should keep v1 intentionally narrow:

- file-level only
- supported languages only
- deterministic output ordering
- explicit `status` and `confidence`
- no implied percentages
- no mutation of repo or ticket state

## Recommended Follow-up

After this contract is accepted, the next implementation slice should be:

- `Add analyze_test_coverage MCP tool`

That ticket should implement the file-level contract above and defer rollups or broader reporting to later tickets.
