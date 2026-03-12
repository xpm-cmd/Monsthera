# Agent Instructions

Use Agora-native access first. Prefer these surfaces in this order:

1. `agora ticket ... --json`, `agora patch ... --json`, `agora knowledge ... --json` for common operational reads and transitions
2. `agora tool inspect <tool> --json` to discover required input
3. `agora tool <tool> --input '{...}' --json` for any local MCP tool with repo-scoped context
4. direct SQLite reads from `.agora/agora.db` only as a last resort when Agora does not expose the needed surface

Rules:

- Prefer `--json` for agent consumption
- Prefer specialized commands over `agora tool` when a specialized command exists
- Use `agora patch list/show` before opening raw diffs when you need patch state, validation, policy violations, warnings, or live staleness vs current `HEAD`
- Use `agora tool` instead of hand-rolled scripts when the underlying capability already exists as an MCP tool
- Do not mutate Agora state through direct SQL unless you are debugging a storage invariant and no safe tool/CLI path exists

Examples:

```bash
agora ticket summary --json
agora patch list --json
agora patch show patch-123 --json
agora knowledge search "ticket workflow" --scope all --json
agora tool list
agora tool inspect propose_patch --json
agora tool status --json
agora tool claim_files --input '{"agentId":"agent-dev","sessionId":"session-dev","paths":["src/index.ts"]}' --json
```

Notes:

- `agora tool` keeps the same repo-scoped context, auth checks, validation, telemetry, and search initialization as the MCP server
- role/session tools still require `agentId` and `sessionId` in the input payload
