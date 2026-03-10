# Agent Roles

## Built-in Roles

### developer
Can retrieve code, propose patches, propose all note types, claim files, broadcast.

### reviewer
Can retrieve code and changes, propose notes (issue, decision, change_note, gotcha). Cannot propose patches.

### observer
Read-only. Can retrieve code and changes, view status. Cannot propose patches or notes.

### admin
Full access to all tools including agent management, role assignment, and configuration.

## Custom Roles

Custom roles can be defined via the dashboard or `agora` CLI. Each role specifies:
- Allowed tools (list of MCP tool names)
- Default trust tier (A or B)
- Whether the role can broadcast
- Whether the role can claim files

## Registration

Agents self-register on first connection via `register_agent(name, type?, desiredRole?, authToken?)`.

By default, registration is open and the requested built-in role is granted as before.
To harden role assignment, configure `.agora/config.json`:

```json
{
  "registrationAuth": {
    "enabled": true,
    "observerOpenRegistration": true,
    "roleTokens": {
      "developer": "dev-secret",
      "reviewer": "review-secret",
      "admin": "admin-secret"
    }
  }
}
```

Behavior when `registrationAuth.enabled` is `true`:

- `observer` remains open if `observerOpenRegistration` is `true`
- `developer`, `reviewer`, and `admin` require a matching `authToken`
- roles without a configured token are not available for self-registration
- failed registration returns an error instead of silently granting a weaker role

The same settings can also be supplied via environment variables:

- `AGORA_REGISTRATION_AUTH=true|false`
- `AGORA_OBSERVER_OPEN_REGISTRATION=true|false`
- `AGORA_ROLE_TOKEN_DEVELOPER=...`
- `AGORA_ROLE_TOKEN_REVIEWER=...`
- `AGORA_ROLE_TOKEN_OBSERVER=...`
- `AGORA_ROLE_TOKEN_ADMIN=...`

## Session Lifecycle

### Ending a Session

Agents should call `end_session(sessionId)` when they finish their work. This:
- Marks the session as `disconnected`
- Releases all file claims held by the session
- Makes the session visible as ended in `agent_status` responses

### Heartbeat and Stale Reaping

Sessions are kept alive implicitly by any tool call that touches the session (e.g., `claim_files`, `broadcast`). If an agent goes silent, the system reaps stale sessions automatically:

- **HEARTBEAT_TIMEOUT_MS**: 10 minutes (600,000 ms)
- `reapStaleSessions()` runs during `agent_status` calls (list-all mode)
- Stale sessions are disconnected and their file claims released
- Agents can maintain presence by periodically calling `claim_files` or `broadcast`

### Agent Tools

| Tool | Description |
|------|-------------|
| `register_agent` | Register and create a session |
| `agent_status` | Get agent/session status (also triggers stale reaping) |
| `broadcast` | Send a message to other agents via Insight Stream |
| `claim_files` | Claim files to prevent double-work (advisory) |
| `end_session` | End a session, release claims |
