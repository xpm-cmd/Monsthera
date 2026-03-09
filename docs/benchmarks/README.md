# Benchmarks

This directory stores benchmark results from running Agora against a representative mixed-language application repository (Python backend + TypeScript/React frontend).

Companion review:

- [`agora-benchmark-review.md`](./agora-benchmark-review.md) — narrative write-up of the latest Agora benchmark results, positioning, strengths, and improvement areas

## Agora vs lexical search

Results from comparing Agora `get_code_pack()` against a scoped lexical baseline built on `rg`, across 12 scenarios in two profiles.

Generated outputs:

- [`agora-vs-lexical-latest.md`](./agora-vs-lexical-latest.md) — human-readable report
- [`agora-vs-lexical-latest.json`](./agora-vs-lexical-latest.json) — machine-readable data

What it measures:

- End-to-end wall time for `get_code_pack` over Agora MCP stdio and HTTP transports
- Internal Agora search latency reported by the server (`latencyMs`)
- End-to-end wall time for a scoped lexical baseline built on `rg`
- Top-1 and Top-5 retrieval success against hand-picked expected files
- Two query profiles: **lexical** (strong keyword overlap) and **semantic** (deliberate lexical gap where rg cannot match but embeddings can)

Interpretation:

- `Agora wall time` includes MCP round-trip and JSON serialization overhead.
- `Agora backend time` is the server-side search cost only.
- `Lexical wall time` is the total cost of the `rg` baseline plus ranking logic.
- On a small repo with strong file naming and carefully scoped queries, the lexical baseline can be competitive or faster in wall-clock time even when Agora's internal search latency is much lower.
- **Semantic profile** shows Agora's key differentiator: queries using domain synonyms (e.g., "skyline" for pareto front, "snapshot" for checkpoint) that embeddings resolve but keyword search cannot.
- HTTP and stdio transport costs should be measured rather than assumed. In the latest run, HTTP was slightly slower than stdio despite comparable backend latency.

## Agora shared context benchmark

Results from measuring duplicated discovery cost across multiple agents working on related tasks.

Generated outputs:

- [`agora-shared-context-latest.md`](./agora-shared-context-latest.md) — human-readable report
- [`agora-shared-context-latest.json`](./agora-shared-context-latest.json) — machine-readable data

What it measures:

- `Without Agora`: each agent resolves its own task with lexical `rg` discovery
- `Agora no hub`: each agent resolves its own task with independent `get_code_pack` calls
- `Agora hub`: one lead agent performs a single code discovery per theme, then shares the result through Agora coordination; worker agents resume from that shared payload

Interpretation:

- This benchmark is about duplicated discovery cost across agents, not single-query search quality.
- The key signal is how many code-index lookups are avoided, plus cumulative wall time across the full multi-agent workflow.
- This is closer to Agora's actual value as a shared context layer than a pure search micro-benchmark.
