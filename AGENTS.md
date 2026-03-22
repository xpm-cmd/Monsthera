# Agent Instructions

Use Monsthera-native access first. Prefer these surfaces in this order:

1. `monsthera ticket ... --json`, `monsthera patch ... --json`, `monsthera knowledge ... --json` for common operational reads and transitions
2. `monsthera tool inspect <tool> --json` to discover required input
3. `monsthera tool <tool> --input '{...}' --json` for any local MCP tool with repo-scoped context
4. direct SQLite reads from `.monsthera/monsthera.db` only as a last resort when Monsthera does not expose the needed surface

Rules:

- Prefer `--json` for agent consumption
- Prefer specialized commands over `monsthera tool` when a specialized command exists
- Use `monsthera patch list/show` before opening raw diffs when you need patch state, validation, policy violations, warnings, or live staleness vs current `HEAD`
- Use `monsthera tool` instead of hand-rolled scripts when the underlying capability already exists as an MCP tool
- Do not mutate Monsthera state through direct SQL unless you are debugging a storage invariant and no safe tool/CLI path exists

Examples:

```bash
monsthera ticket summary --json
monsthera patch list --json
monsthera patch show patch-123 --json
monsthera knowledge search "ticket workflow" --scope all --json
monsthera tool list
monsthera tool inspect propose_patch --json
monsthera tool status --json
monsthera tool claim_files --input '{"agentId":"agent-dev","sessionId":"session-dev","paths":["src/index.ts"]}' --json
```

Notes:

- `monsthera tool` keeps the same repo-scoped context, auth checks, validation, telemetry, and search initialization as the MCP server
- role/session tools still require `agentId` and `sessionId` in the input payload
