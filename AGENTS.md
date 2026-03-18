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

---

## Agora Office — Environment (read FIRST before writing code)

### Runtime

- Node.js v25+ — do NOT use `better-sqlite3` (fails to compile on v25)
- For the Agora Office server: use `import { DatabaseSync } from 'node:sqlite'` (built-in)
- Dev server: `node --experimental-sqlite --import tsx/esm src/index.ts`
- The `dev` script in package.json already includes these flags
- Package manager: pnpm with workspaces

### DB Path (CRITICAL)

```
AGORA_DB_PATH=<repo_root>/.agora/agora.db
```

See `.env.example` for the exact value. The server opens this DB **read-only** — never write to it.

### PixiJS + React

- Do NOT use `React.StrictMode` — it destroys the WebGL context in dev mode
- Characters go in `charLayer` (via `addCharacterToWorld`), tiles in `tileLayer` (via `addToWorld`)
- Scale sprites: `container.scale.set(2.5)`
- Isometric tiles: 64×32 (2:1 standard), depth-sorted by `(col + row)`

---

## Agora DB Schema Reference

Source of truth: `src/db/schema.ts`. Drizzle ORM uses camelCase in TypeScript but the SQLite columns are snake_case. Both are listed below.

> **Common gotchas:**
> - `patches` uses `state` (NOT "status") and `committed_sha` (NOT "sha")
> - `dashboard_events` uses `data_json` (NOT "payload") and `timestamp` (NOT "created_at")
> - `tickets.id` is an integer PK; `tickets.ticket_id` is the text `TKT-xxx` identifier
> - `council_assignments` uses `assigned_at` (NOT "created_at")

### agents

| SQLite column | Drizzle key | Type | Notes |
|---|---|---|---|
| id | id | text PK | |
| name | name | text | |
| type | type | text | default "unknown" |
| provider | provider | text | nullable |
| model | model | text | nullable |
| model_family | modelFamily | text | nullable |
| model_version | modelVersion | text | nullable |
| identity_source | identitySource | text | nullable |
| role_id | roleId | text | default "observer" |
| trust_tier | trustTier | text | default "B" |
| registered_at | registeredAt | text | |

### sessions

| SQLite column | Drizzle key | Type | Notes |
|---|---|---|---|
| id | id | text PK | |
| agent_id | agentId | text FK→agents | |
| state | state | text | "active" or "disconnected" |
| connected_at | connectedAt | text | |
| last_activity | lastActivity | text | |
| claimed_files_json | claimedFilesJson | text | JSON array |
| worktree_path | worktreePath | text | nullable |
| worktree_branch | worktreeBranch | text | nullable |

### tickets

| SQLite column | Drizzle key | Type | Notes |
|---|---|---|---|
| id | id | integer PK | auto-increment |
| repo_id | repoId | integer FK→repos | |
| ticket_id | ticketId | text UNIQUE | TKT-{uuid8} — use as external ID |
| title | title | text | |
| description | description | text | |
| status | status | text | default "backlog" |
| severity | severity | text | default "medium" |
| priority | priority | integer | default 5 |
| tags_json | tagsJson | text | JSON array |
| affected_paths_json | affectedPathsJson | text | JSON array |
| acceptance_criteria | acceptanceCriteria | text | nullable |
| creator_agent_id | creatorAgentId | text | |
| creator_session_id | creatorSessionId | text | |
| assignee_agent_id | assigneeAgentId | text | nullable |
| resolved_by_agent_id | resolvedByAgentId | text | nullable |
| commit_sha | commitSha | text | |
| required_roles_json | requiredRolesJson | text | JSON array |
| created_at | createdAt | text | |
| updated_at | updatedAt | text | |

### dashboard_events

| SQLite column | Drizzle key | Type | Notes |
|---|---|---|---|
| id | id | integer PK | |
| repo_id | repoId | integer FK→repos | |
| event_type | eventType | text | |
| data_json | dataJson | text | JSON blob — NOT "payload" |
| timestamp | timestamp | text | NOT "created_at" |

### council_assignments

| SQLite column | Drizzle key | Type | Notes |
|---|---|---|---|
| id | id | integer PK | |
| ticket_id | ticketId | integer FK→tickets | |
| agent_id | agentId | text | |
| specialization | specialization | text | |
| assigned_by_agent_id | assignedByAgentId | text | |
| assigned_at | assignedAt | text | NOT "created_at" |

### patches

| SQLite column | Drizzle key | Type | Notes |
|---|---|---|---|
| id | id | integer PK | |
| repo_id | repoId | integer FK→repos | |
| proposal_id | proposalId | text UNIQUE | |
| base_commit | baseCommit | text | invariant 2 |
| bundle_id | bundleId | text | provenance, nullable |
| state | state | text | NOT "status" |
| diff | diff | text | |
| message | message | text | |
| touched_paths_json | touchedPathsJson | text | JSON array |
| dry_run_result_json | dryRunResultJson | text | JSON object |
| agent_id | agentId | text | |
| session_id | sessionId | text | |
| committed_sha | committedSha | text | NOT "sha", nullable |
| ticket_id | ticketId | integer FK→tickets | |
| created_at | createdAt | text | |
| updated_at | updatedAt | text | |

### coordination_messages

| SQLite column | Drizzle key | Type | Notes |
|---|---|---|---|
| id | id | integer PK | |
| repo_id | repoId | integer FK→repos | |
| message_id | messageId | text UNIQUE | |
| from_agent_id | fromAgentId | text | |
| to_agent_id | toAgentId | text | nullable (null = broadcast) |
| type | type | text | |
| payload_json | payloadJson | text | JSON object |
| timestamp | timestamp | text | |

---

## Pre-Submission Validation Checklist

**MANDATORY** before calling `update_ticket_status("in_review")`. If any step fails → fix → repeat from step 1. Never mark `in_review` with known failures.

```bash
# 1. For ALL tickets — type check
pnpm build  # must exit 0 with no errors

# 2. For server tickets — runtime verification
AGORA_DB_PATH="$(pwd)/.agora/agora.db" pnpm --filter @agora-office/server dev &
sleep 4
curl -sf http://localhost:3001/health | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok', f'health failed: {d}'"
curl -sf http://localhost:3001/state  | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'agents' in d and 'tickets' in d, f'state missing keys: {list(d.keys())}'"
kill %1

# 3. For client tickets — UI verification
AGORA_DB_PATH="$(pwd)/.agora/agora.db" pnpm --filter @agora-office/server dev &
pnpm --filter @agora-office/client dev &
sleep 8
curl -sf -o /dev/null -w "%{http_code}" http://localhost:5173 | grep -q "200"
kill %1 %2
```

**Absolute rule:** If step 1 fails → do NOT proceed to step 2 or 3. Fix build errors first.

---

## Auto-Correction Loop

When you hit an error, follow this loop. Max 3 attempts before escalating.

1. **Read the error completely** — do not guess the cause
2. **Identify and fix the root cause:**
   - `TS2742` → add explicit return type annotation
   - `no such column X` → run `.schema <table>` in SQLite and use the real column name (see schema reference above)
   - `Cannot find module` → verify the import path exists and the symbol is exported
   - `EADDRINUSE` → `lsof -ti:<port> | xargs kill -9`
   - `SQLITE_READONLY` → check `AGORA_DB_PATH` points to the right file
3. **Re-run validation** from step 1 of the checklist
4. **If still failing after 3 attempts:**
   ```bash
   agora tool comment_ticket --input '{"ticketId":"TKT-xxx","content":"[BLOCKED] <exact error and what was tried>","agentId":"<id>","sessionId":"<sess>"}'
   agora tool send_coordination --input '{"type":"conflict_alert","payload":{"message":"<error>"},"agentId":"<id>","sessionId":"<sess>"}'
   agora tool update_ticket_status --input '{"ticketId":"TKT-xxx","status":"blocked","agentId":"<id>","sessionId":"<sess>"}'
   ```
   Do NOT mark `in_review` with unresolved errors.

---

## OpenCode Agent Onboarding

If you are an OpenCode agent joining this project:

```bash
# 1. Register with Agora
agora tool register_agent --input '{
  "name": "opencode-dev-01",
  "desiredRole": "developer",
  "type": "opencode"
}'
# → Save agentId and sessionId from the response. Required in EVERY call.

# 2. Find work
agora tool list_tickets --input '{"status":"approved","agentId":"<your-id>","sessionId":"<your-session>"}'

# 3. Claim and start
agora tool assign_ticket --input '{"ticketId":"TKT-xxx","assigneeAgentId":"<your-id>","agentId":"<your-id>","sessionId":"<your-session>"}'
agora tool update_ticket_status --input '{"ticketId":"TKT-xxx","status":"in_progress","agentId":"<your-id>","sessionId":"<your-session>"}'
```

**Full lifecycle:**
```
register → list_tickets(approved) → assign_ticket → update_ticket_status(in_progress)
→ [implement] → [run validation checklist] → comment_ticket(progress)
→ update_ticket_status(in_review) → end_session
```

**CRITICAL:** Never omit `agentId` and `sessionId` — most tools require them and fail silently without them.

---

## Council Reviewer Workflow

If your role is `reviewer`, follow this for every ticket in `in_review`:

1. **Read ALL files** the ticket modified (check `affectedPathsJson` on the ticket)
2. **Build:** `pnpm build` — 0 errors is required to vote PASS
3. **Runtime check (server tickets):**
   ```bash
   AGORA_DB_PATH="$(pwd)/.agora/agora.db" pnpm --filter @agora-office/server dev &
   sleep 4 && curl -sf http://localhost:3001/health && curl -sf http://localhost:3001/state
   kill %1
   ```
4. **Submit verdict with specific reasoning:**
   ```bash
   agora tool submit_verdict --input '{
     "ticketId": "TKT-xxx",
     "specialization": "architect",
     "verdict": "pass",
     "reasoning": "Build clean. Server /health ok. /state has agents[] and tickets[]. Follows spec section 4.",
     "agentId": "<your-id>",
     "sessionId": "<your-session>"
   }'
   ```

**Rules:**
- **PASS** only if: build clean + runtime works + acceptance criteria met
- **FAIL** with specific findings: what you verified, what broke, how to fix it
- **Never vote PASS** without running the build and runtime checks

---

## Browser Verification (Client Tickets)

For any ticket modifying `packages/client/`, verify in a browser before `in_review`:

```bash
npx playwright screenshot http://localhost:5173 /tmp/screenshot-$(date +%s).png --wait-for-timeout 5000
```

**Visual acceptance criteria (ALL required):**
- Isometric map visible with distinct room colors
- Characters visible ABOVE tiles (not hidden behind them)
- UI overlay (AGORA OFFICE badge) visible
- No completely black or white screen
- No `TypeError` in browser console

If any criterion fails → the ticket cannot be marked `in_review`.

---

## Planner Rules: Ask Before Fabricating

If you cannot answer these 3 questions about a ticket:

1. **What files** exactly will be created or modified? (exact paths)
2. **What DB columns** will the code use? (verified against the schema reference above)
3. **How do you verify** the acceptance criteria are met?

Then **do NOT post `[Plan Iteration]`**. Instead:

```bash
agora tool comment_ticket --input '{"ticketId":"TKT-xxx","content":"[BLOCKED — need clarification] <specific question>","agentId":"<id>","sessionId":"<sess>"}'
```

**Signals that you ARE ready to post a plan iteration:**
- You can name `src/path/to/file.ts` with the line range to change
- You verified column names against the schema reference (not from memory)
- You can describe the data flow from input to output
- You identified at least 1 risk or dependency
