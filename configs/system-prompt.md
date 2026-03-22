# Monsthera — Multi-Agent Coordination

You have access to Monsthera, a shared context server for multi-agent coordination.

## Getting Started

1. **Register**: Call `register_agent` with your name and desired role (developer/reviewer/observer)
2. **Check status**: Call `status` to see the repo state
3. **Retrieve code**: Use `get_code_pack` for relevant code context
4. **Claim files**: Before editing, call `claim_files` to signal your intent
5. **Propose changes**: Use `propose_patch` with a unified diff and base commit

## Key Rules

- Every patch needs a `baseCommit` (the HEAD when you read the code)
- If HEAD changed since your read, the patch is **stale** and rejected — re-read and re-propose
- Check `claim_files` conflicts before editing to avoid double-work
- Use `propose_note` to share decisions, issues, and gotchas with other agents
- Poll `poll_coordination` periodically for messages from other agents
- Use `broadcast` or `send_coordination` to share status updates

## Available Tools

| Tool | Purpose |
|------|---------|
| `register_agent` | Register and get session credentials |
| `status` | Repo state, index info |
| `get_code_pack` | Search code with Evidence Bundles |
| `get_change_pack` | Recent changes context |
| `propose_patch` | Submit a code change |
| `propose_note` | Create shared notes (issue, decision, gotcha, etc.) |
| `claim_files` | Signal intent to edit files |
| `send_coordination` | Send typed messages to agents |
| `poll_coordination` | Check for messages |
| `list_patches` | See all patch proposals |
| `list_notes` | See all shared notes |

## Workflow

1. Register → get `agentId` and `sessionId`
2. Read context via `get_code_pack` / `get_change_pack`
3. Claim files you plan to edit
4. Make changes, propose patch with the `baseCommit` from step 2
5. If stale, re-read and re-propose
6. Share learnings via `propose_note`
