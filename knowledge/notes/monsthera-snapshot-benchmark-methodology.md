---
id: k-pwksnl38
title: Benchmark Methodology — Environment Snapshot + build_context_pack Impact
slug: monsthera-snapshot-benchmark-methodology
category: research
tags: [agents, benchmark, terminal-bench, context, bootstrapping, methodology]
codeRefs: [src/context/snapshot-service.ts, src/tools/search-tools.ts, src/tools/snapshot-tools.ts, scripts/capture-env-snapshot.ts]
references: [k-to46fuoi]
createdAt: 2026-04-19T00:00:00.000Z
updatedAt: 2026-04-19T00:00:00.000Z
---

Companion methodology for the benchmark spike `w-uvp3azdf`. Explains how to run a reproducible A/B against a public terminal-task set using Monsthera's environment-snapshot and `build_context_pack` surface, so the "2-5 reconnaissance turns" claim the IRIS Meta-Harness artifact makes (see `k-to46fuoi`) can be measured empirically instead of asserted.

Nothing in this note is a result — results live in the spike's work article. This note is the playbook.

## Scope

- A/B one agent harness with and without a snapshot-aware prelude.
- 10-20 tasks from a public terminal-task set (Terminal-Bench 2 candidates; see "Task selection" below).
- Three metrics: input tokens per task, wall-clock turns to first useful tool call, and overall success rate.
- Single model throughout the comparison (Claude-class). The point is not to rank models; the point is to isolate the snapshot signal.
- Single sandbox per task, rebuilt between arms so both arms see the same fresh container.

## Non-goals

- No claim that Monsthera beats Meta-Harness. We do not re-run the IRIS artifact; apples-to-apples would require matching its harness exactly, which is out of scope. The spike measures the delta Monsthera's surface produces on its own harness, not the absolute number.
- No evaluation of semantic-context gains from `build_context_pack` in isolation. That was already measured qualitatively in PR #59; the spike's job is to confirm the IRIS-style cold-start savings transfer when semantic + physical context ride together.
- No UI / dashboard involvement. Everything runs headless through the MCP surface or a small driver script.
- No production rollout plan. "Does it help" first, "how to roll out" second.

## Task selection

Pick 10-20 tasks from Terminal-Bench 2 (or a similar public set, e.g. SWE-bench Lite subset, OpenHands benchmarks — whichever is licensing-clean and small enough to run in an afternoon).

Selection criteria:

- A mix of "cold-start dominant" and "execution dominant" tasks. Expect larger savings on the former. Label each task `cold-start | execution | mixed` at selection time.
- At least one per language surface the project exercises: Python, TypeScript, Rust, Go. This exposes the runtime-probe signal rather than testing one ecosystem.
- Tasks whose ground truth is scriptable, not judged by an LLM. Avoid pair-wise judge noise.

Record the task ids and the label in the spike article. Do not cherry-pick after first run — a second pass after seeing numbers is data leakage.

## Arms

- **Arm A — baseline**: the harness starts with only the task prompt. No snapshot, no `build_context_pack` call. This is the control.
- **Arm B — snapshot + pack**: before the first LLM turn the driver:
  1. Runs `scripts/capture-env-snapshot.ts --agent-id <agent> --work-id <work>` and pipes JSON into `record_environment_snapshot`.
  2. Calls `build_context_pack(query=<task-summary>, agent_id=<agent>, work_id=<work>)` with `include_content: false` so the payload stays slim.
  3. Prepends the returned `summary`, top N `items` (ids + titles + snippets), and the `snapshot` block into the initial user message.
- No other difference between arms. Same model, same temperature, same max-tokens, same stop condition.

Rationale: Arm B reproduces the IRIS bootstrap idea (physical context at T=0) while layering semantic context (what this project means) on top. That layering is the novel bit vs. Meta-Harness.

## Driver shape

A small TypeScript driver (kept outside this PR; lives in a spike scratchpad or a separate tools-bench repo):

```ts
interface TrialResult {
  taskId: string;
  arm: "A" | "B";
  inputTokens: number;
  outputTokens: number;
  turnsToFirstUsefulCall: number; // first tool call other than ls / pwd / cat
  success: boolean;
  wallClockMs: number;
  reconTurns: number;             // turns spent running ls / which / cat before acting
}
```

Constraints:

- Driver is stateless between trials. Container, sandbox, and model session are all fresh. The snapshot is regenerated per trial in Arm B (IRIS's approach; Monsthera supports it natively).
- Every trial writes a JSONL row to `bench-out/trials.jsonl`. Make no attempt to aggregate mid-run — tally at the end from the JSONL.
- Seed the task ordering randomly but reproducibly (log the seed) so ordering effects wash out with multiple passes.

## Metrics

Three must-have, two nice-to-have.

### Must-have

1. **Input tokens per task** (arm mean + stdev). The snapshot block is ~200-500 tokens slim. Arm B must show a gain *despite* this cost.
2. **Reconnaissance turns before first useful tool call**. Defined as: number of model turns whose only tool calls are `ls`, `pwd`, `which`, `cat <known file>`, `find`, `stat`, `env`, `node --version`, `python --version`, `which python3`, `cat pyproject.toml | head`, `cat package.json | head`, `uname -a`. One turn with any non-reconnaissance call flips the counter. This is the number the IRIS artifact claims to cut.
3. **Success rate**. Snapshot + pack must not hurt success. If it does, that is the headline finding.

### Nice-to-have

4. Wall-clock time per task. Less meaningful at low trial counts but free to collect.
5. Snapshot staleness rate: number of runs that surfaced a `stale_snapshot` guidance entry. Should be 0 in Arm B because the driver re-captures on every trial. Non-zero means the driver has a bug.

## Reporting shape

The spike article posts a single table per metric, arms side by side, with n, mean, stdev, and the two-sample delta. Plus a short narrative paragraph calling out:

- Per-category delta (`cold-start` vs. `execution` labels). We expect the signal to concentrate on cold-start tasks; if it does not, the story changes.
- Any task where Arm B regressed vs. Arm A. Those are the tasks that would reveal over-eager context.
- Estimated tokens saved per $1 at current pricing. Anchors the "is this worth it" conversation in operational cost.

Minimum presentation:

| Metric | Arm A (n=k) | Arm B (n=k) | Δ (B-A) | p (approx) |
| :-- | --: | --: | --: | --: |
| Input tokens / task | ... | ... | ... | ... |
| Recon turns / task | ... | ... | ... | ... |
| Success rate | ... | ... | ... | ... |

"p (approx)" can be a paired t-test or a Wilcoxon signed-rank — n is small, so report whichever is defensible and mention that "significance at n=10-20 is directional, not confirmatory". Be honest about the limits.

## Threats to validity

- **Model drift.** Re-running months later with a newer model version invalidates the absolute numbers. Lock the model id at the trial time and record it in the output.
- **Prompt overfitting.** The way the snapshot block is formatted changes token count and model behavior. Use the slim shape already returned by `build_context_pack` — do not hand-tune formatting. If a future PR changes that shape, the benchmark must be re-run.
- **Task curation bias.** Picking only cold-start tasks guarantees the result. Document the mix and keep the ratio pre-registered.
- **Ordering effects.** Randomize, log the seed, and rerun with a different seed if the first run shows surprising ordering.
- **Implementation bugs in the driver.** Before the main run, run a single-task calibration in both arms and spot-check the `inputTokens` / `reconTurns` values by hand.

## Reproducing from scratch

1. Clone `xpm-cmd/monsthera` at the commit that ships all four follow-ups (`w-guptmc33`, `w-y988ky96`, `w-r85lzqhv`, this spike).
2. `pnpm install`.
3. Start a fresh sandbox per task. Any container or microVM with the required runtimes installed. The capture helper reads `/proc/meminfo`, `git rev-parse`, and lockfile sha256 — none of those require root.
4. Run the driver: `pnpm exec tsx scripts/bench-driver.ts --tasks terminal-bench-subset.json --model claude-opus-4-6 --arm both --out bench-out/trials.jsonl`. The driver is intentionally not part of this PR — it lives next to the spike work article and can be trashed after the numbers land.
5. Post the table + narrative in the spike work article under `## Results`.

## Linkage

- Parent research note: `k-to46fuoi`.
- Parent MVP work: `w-0ieze72s` (PR #59).
- Follow-ups whose combined surface this benchmark targets: `w-guptmc33` (Dolt persistence), `w-y988ky96` (snapshot-ready guard), `w-r85lzqhv` (dashboard drift banner), `w-uvp3azdf` (this spike).
- Stanford IRIS artifact that motivated the number to beat (or match): see `k-to46fuoi` for the upstream repo link and the 76.4% Terminal-Bench 2.0 result that anchors the recon-turns claim.
