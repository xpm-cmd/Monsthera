---
id: w-uvp3azdf
title: Benchmark: snapshot + build_context_pack cold-start impact
template: spike
phase: enrichment
priority: medium
author: agent-claude-followups
tags: [snapshot, benchmark, terminal-bench, cold-start, spike, followup, iris-research]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-19T09:24:43.978Z
updatedAt: 2026-04-19T09:25:26.002Z
enrichmentRolesJson: {"items":[]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-19T09:24:43.978Z","exitedAt":"2026-04-19T09:25:26.002Z"},{"phase":"enrichment","enteredAt":"2026-04-19T09:25:26.002Z"}]}
---

## Objective

Quantify whether the environment-snapshot + `build_context_pack` surface actually cuts cold-start reconnaissance turns and input tokens on a public terminal-task set, versus a baseline that skips both. The research note (`k-to46fuoi`) argues the IRIS Meta-Harness artifact saves 2-5 turns by injecting a sandbox snapshot at T=0; the MVP (`w-0ieze72s`, PR #59) ships the surface but has never been measured.

## Research Questions

1. Does prepending `build_context_pack(work_id=..., agent_id=...)` + a fresh `record_environment_snapshot` to the initial user message reduce reconnaissance turns (ls / pwd / which / cat) before the first useful tool call? By how much?
2. Net of the ~200-500 input tokens the snapshot block adds, does Arm B consume fewer total input tokens per task than Arm A?
3. Does Arm B preserve or improve success rate? (A regression here is the most interesting finding — it would suggest over-eager context is an anti-pattern for this harness.)
4. Does the effect size differ between cold-start-dominant tasks and execution-dominant tasks? (Expectation: the signal concentrates on cold-start.)
5. Does the snapshot block ever surface `stale_snapshot` guidance in Arm B? (Expectation: never — driver recaptures per trial. Anything else is a driver bug.)

## Approach

Full methodology lives in the companion knowledge article `k-pwksnl38` ("Benchmark Methodology — Environment Snapshot + build_context_pack Impact"). Summary of the plan:

- Pick 10-20 tasks from Terminal-Bench 2 (or an equivalent licensing-clean public set). Label each `cold-start | execution | mixed` at selection time. No post-hoc re-picking.
- Two arms. Arm A (baseline): task prompt only. Arm B: driver runs `scripts/capture-env-snapshot.ts`, pipes JSON into `record_environment_snapshot`, calls `build_context_pack(query=<summary>, work_id, agent_id)`, and prepends the slim response (summary + top N items + `snapshot` block) into the initial user message. Same model, temperature, max-tokens, stop condition in both arms.
- Run each task N times per arm (target N=3 for stability; higher if budget allows). Log per-trial results as JSONL in `bench-out/trials.jsonl` with fields `{taskId, arm, inputTokens, outputTokens, turnsToFirstUsefulCall, success, wallClockMs, reconTurns}`.
- Metrics: input tokens per task (mean, stdev); reconnaissance turns before first useful tool call; success rate. Nice-to-have: wall-clock, staleness-guidance rate.
- Report as a small table with paired statistics at n=10-20. Be explicit that significance is directional, not confirmatory, at this scale.

## Driver

A self-contained TypeScript driver (`scripts/bench-driver.ts`) that:

1. Reads a task JSON file (`tasks: { id, prompt, evalScript, label }[]`).
2. For each task × arm × trial: spawns a fresh sandbox, runs Arm A or Arm B, captures stdout + model API usage (input / output tokens per call), counts reconnaissance turns by tool-call pattern, runs the task's `evalScript` to record success, appends a JSONL row.
3. Aggregates at the end and prints a markdown table plus a per-task breakdown.

Intentionally NOT landing in this repo as production code. It lives in a spike scratchpad — either a sibling folder or a separate tools-bench repo. Keeping it out of the main codebase avoids commitment to a benchmark harness we have not yet validated.

## Deliverables

- [ ] A task manifest (JSON) with 10-20 selected tasks and their `cold-start | execution | mixed` labels, committed alongside the driver (wherever that lives).
- [ ] A `bench-out/trials.jsonl` artifact with all per-trial rows. Reproducible via the driver given the same model id and task manifest.
- [ ] A results section on THIS work article (under `## Results`, appended during the `enrichment` phase) with:
  - A paired-arms table for each of the three must-have metrics.
  - Per-label split (cold-start vs. execution vs. mixed).
  - A short narrative (≤300 words) calling out the biggest deltas, any Arm B regressions, and estimated cost impact per \$1 of input tokens at current pricing.
- [ ] Updates to the parent research note (`k-to46fuoi`) with a "Measured results" subsection linking here. (Only if results support the hypothesis — if they refute it, still link, and reword the note's "cold-start savings" claims accordingly.)

## Constraints

- Single model across the whole run. Log the exact model id. A rerun under a different model is a new benchmark, not a continuation.
- No changes to Monsthera production code as part of this spike. If the benchmark reveals a bug, file a separate work article; do not patch in-place and rerun — that is data leakage.
- No subprocess use from the MCP server. The driver, like the capture helper, runs client-side.
- Numbers are directional at n=10-20. Say so in the write-up; do not overstate.

## Risks / Notes

- Token accounting is provider-specific. Use the model API's reported usage fields, not a local estimator.
- The snapshot block's token cost could regress if future work widens the shape. Record the exact `build_context_pack` commit sha in the results table.
- Task set licensing: pick one whose license permits redistribution of the inputs (or reference-only — we do not need to embed the task text).
- The driver's reconnaissance-turn classifier is a heuristic (ls / pwd / which / cat / env / find / stat / `<runtime> --version`). Calibrate it by hand on one task per arm before the main run. False positives here bias in favor of Arm B.
- Arm B's `build_context_pack` returns different items depending on the knowledge corpus state at that commit. Pin the Monsthera commit sha for the run and note it.

## Exit Criteria

This spike is done when:

- The work article has a `## Results` section with the required tables and per-label split.
- The knowledge article `k-pwksnl38` is updated with a pointer back to the results.
- The research note `k-to46fuoi` has a "Measured results" subsection (positive OR negative) linking here.

No code lands in the main repo as part of this spike's closing transition.