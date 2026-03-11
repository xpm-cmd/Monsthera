# Local LLM Proxy Recommendation

Status: recommended to defer bridge/proxy work for now.

Related ticket: `TKT-ee25c3cf`

## Recommendation

Agora does not need a thin MCP proxy for local LLM agents at this stage.

Use the existing transports directly:

- `stdio` for a single local operator or a client that can launch Agora itself
- HTTP (`agora serve --transport http`) when multiple local tools or agents need to share one Agora runtime

## Evidence

- Agora already exposes the full MCP surface over both `stdio` and HTTP.
- The local-model path is already documented for OpenCode and Ollama without any extra bridge layer.
- Architecture docs already treat the dashboard and HTTP transport as local runtime surfaces over the same repo database.
- Recent transport benchmarks show HTTP was slightly slower than `stdio`, so adding another proxy layer is more likely to add overhead than remove it.

## When a proxy would be justified

A thin proxy should only move back into scope if we hit a concrete gap that direct `stdio` or HTTP cannot solve cleanly, such as:

- a client that cannot launch a local MCP process and cannot speak Agora's HTTP transport directly
- centralized auth or trust brokering across multiple Agora instances
- multi-repo routing or policy enforcement that should not live in a single repo-local Agora runtime
- measured batching or session-pooling wins that cannot be achieved in the current transports

## Scope Reduction

- Keep the bridge umbrella deferred.
- Prioritize auth/trust and multi-repo strategy work ahead of any proxy layer.
- Revisit only if a real operator workflow fails with direct `stdio` or direct HTTP.
