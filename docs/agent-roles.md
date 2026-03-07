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

Agents self-register on first connection via `register_agent(name, type?, desired_role?)`.
The system assigns the role based on configuration or defaults to `observer`.
Pre-registered agents (via config or dashboard) get their assigned role automatically.
