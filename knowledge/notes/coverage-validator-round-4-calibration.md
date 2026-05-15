---
id: k-cv-round-4-calibration
title: Coverage validator — round 4 calibration learnings
slug: coverage-validator-round-4-calibration
category: gotcha
tags: [sessions, handoff, coverage-validator, calibration, gotchas, shipping-lessons, dogfood]
codeRefs: [src/sessions/coverage-validator.ts, src/sessions/handoff-renderer.ts, src/sessions/llm-summarizer.ts]
references: [cognitive-handoff-sessions, phase-4a-4b-shipping-non-obvious-learnings]
createdAt: 2026-05-15T13:25:00.000Z
updatedAt: 2026-05-15T13:25:00.000Z
---

# Coverage validator — round 4 calibration learnings

Captures what surfaced while dogfooding the handoff coverage validator a fourth time, after the initial three calibration cycles documented in commit `38d4587`. Round 4 shipped in three commits — `d49ad24` (renderer + prompt), `e8018f4` (validator regex broadening), `e3d34f1` (Facts pointer strip fix). The Facts-pointer fix is the headline find: a structural false-positive that lurked through three calibration rounds without anyone noticing.

## Three calibration rounds passed the validator's own test because every hand-built fixture omitted the Facts section

Commit `38d4587`'s test suite has 12 tests using two hand-built bodies (`RICH_BODY` and `THIN_BODY` in `tests/unit/sessions/coverage-validator.test.ts`). Both fixtures omit the `## Facts (raw, for downstream LLM)` section that every non-degraded handoff carries in production.

Round 4's first dogfood — a deliberate negative close with `--note "Did some stuff."` — surfaced the bug immediately: the validator flagged only `verification`, not the three gaps expected. Tracing back showed `hasExecutableAction` was crediting the body via `` `<session-id>.facts.json` `` — the backticked filename in the Facts pointer that the renderer appends as the last section. The validator's `[a-zA-Z_][\w./-]*\.(ts|...|json|...)` regex matches it, even though it's a navigation artifact, not an action.

**Decision rule for next time**: when writing test fixtures for content-validation logic against a real renderer, **include the structural sections the renderer always emits**. Or, alternatively, evaluate against fixtures saved from real dogfood (round 4 did this in `it("pins behavior on the degraded T1-only fixture", ...)` but the fixture omitted the Facts section, so the bug stayed hidden). Bias toward real-output fixtures, not minimal hand-built ones.

## Renderer-level fixes beat prompt-level fixes when "don't invent" must hold

The dogfood revealed quality 4/5 handoffs flagging `constraints` because `summary.blockers === []` made the renderer skip the `### Blockers` heading entirely. Two ways to fix:

- **Prompt-level**: instruct the LLM to write `"blockers": [{"text": "No blockers identified.", ...}]` when there genuinely are none. Contradicts existing rule 6 ("Do not invent") and asks the LLM to fabricate content.
- **Renderer-level**: always emit `### Blockers` with `_(none identified)_` placeholder. Deterministic; doesn't ask the LLM to lie.

Shipped the renderer fix (`handoff-renderer.ts:94`). The LLM's array stays `[]`; only the renderer adds the placeholder line. This preserves the no-invention contract while still giving the validator a heading to credit and the next agent a useful "we actively checked, none found" signal.

**Decision rule**: when a coverage/quality validator's heuristic depends on structural shape (headings, table-of-contents links, etc.), prefer fixing the renderer to emit a consistent shape. Don't ask the LLM to produce structure that contradicts its content-grounding rules.

## Defense-in-depth: prompt asks, validator accepts both forms

The validator's `hasExecutableAction` and `hasVerification` previously required backticks. Round 4 found that gemma4 sometimes drops backticks even when the agent's `--note` had them. Two layers of fix:

- **Prompt layer** (`llm-summarizer.ts:127`): rule 5 now explicitly instructs the LLM to put verification commands in `nextSteps[].why` field AND wrap file paths and commands in backticks.
- **Validator layer** (`coverage-validator.ts:75-79, :100-101`): added bare-prose acceptance for both dimensions. Requires high-specificity suffix (`:line` for files, recognizable subcommand for CLI verbs) so prose like "see foo.ts" or "run the tests" doesn't false-positive.

The positive dogfood (`handoff-ses-20260515-131418-claude-code`) showed the prompt change works end-to-end — the LLM produced `` `pnpm test tests/unit/sessions/` `` in the why field unprompted. The validator change is pure defense-in-depth: in case the LLM regresses (heh) in a future model swap, the bare-form heuristics catch it.

**Decision rule**: when a validator's heuristic depends on LLM output discipline, ship the validator fallback first and the prompt tightening second. Worst case: prompt fails, validator still works. Best case: both work and you have a redundant signal.

## "(none) is more useful than silence" is a first-class principle, encoded in the renderer and in the suggestion text

The validator's existing suggestion for `hasConstraints` already says: _"Add a Blockers or Deferred section — even an explicit `(none)` is more useful than silence."_ The round 4 renderer change makes the renderer enforce this for blockers automatically. The principle generalizes:

- **Silence is ambiguous.** A handoff with no `### Blockers` heading could mean "no blockers found" or "I didn't check." The next agent can't distinguish.
- **Explicit (none) collapses the ambiguity.** "_(none identified)_" tells the next agent: "we actively checked; nothing to flag."
- The renderer is the right layer for this enforcement. The LLM shouldn't be in the loop for structural placeholders — that's what risks invention.

Could be extended to other dimensions (e.g. always emit `### Surprises _(none)_` and `### Deferred _(none)_`). Round 4 deliberately scoped to Blockers because `hasConstraints` checks for any of `Blockers|Deferred|Open questions|Constraints|Watch-outs?` — one explicit heading suffices.

## Calibration cycles compound: each dogfood reveals a different failure mode

- Round 1 (during `38d4587`): caught the rich-body zero-gap path and thin-body three-gaps path. Hand-built fixtures.
- Round 2: caught the LLM eliding `pnpm test ...` from rich notes. Validator wasn't changed, but the commit message flagged "loss of fidelity" as a known issue.
- Round 3: caught the `\bregress\b` literal vs `regress(es|ion)?` test-seed mismatch. Fixed in test fixture rather than validator (production regex was already broader).
- Round 4: caught structural Facts-pointer false-positive + empty Blockers heading skip + missing verification command instruction. Three commits, all renderer/prompt/validator co-located.

The pattern is reliable: each dogfood reveals one or two issues, each fixable in <50 LOC, each shipped as its own commit with the dogfood evidence persisted alongside. No round invalidated the previous round's findings. Test-count growth tracks: round 1 added 12, round 4 added 7 (1 in coverage-validator.test.ts for Facts strip + 6 for the bare-prose / regress variants).

**Decision rule for future calibration**: each round should ship validator + renderer + prompt changes in self-contained commits with the dogfood evidence handoff articles bundled. The article corpus IS part of the test suite — both for human review and for future fixture-replay tests.

## What's NOT yet calibrated (deferred to round 5+)

- `hasState` accepts any `## Hypergraph` heading, even when the Hypergraph body has only `Events in window: 0`. A zero-event handoff (no work touched, no code touched) still credits state. Acceptable for now — degraded handoffs and "just opened, immediate close" sessions don't actually have state to report. But if a thin handoff's Hypergraph is empty AND no commit:<sha> appears, that's the "no state" case worth flagging.
- `hasIntent` requires `> Intent:` exactly. If a user opens a session without `--intent` and the LLM doesn't infer one into the preamble (which it doesn't today — `Session.intent` flows through the renderer header, not the LLM), the dimension flags. That's correct, but the suggestion text could nudge harder ("re-open with `--intent` next time, OR the agent can include intent in the `--note`'s WHY block").
- `### Blockers _(none identified)_` is now structural, which means the validator's `hasConstraints` regex always credits constraints on rendered handoffs. That's intentional — silence collapses to "(none)" — but it does mean the `constraints` gap can ONLY appear in T1-only / degraded handoffs (which skip `renderWhatHappened` entirely). That's fine, but worth pinning in a test if degraded-mode constraints crediting becomes a concern.

These are not bugs; they're scope-boundaries for round 4. Worth a follow-up if a future dogfood surfaces them as real issues.
