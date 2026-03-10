# Agent Roles

## Built-in Roles Only

Agora currently supports only four runtime roles:

- `developer`
- `reviewer`
- `observer`
- `admin`

The `roles` table exists as future-facing groundwork, but custom roles are not yet a supported product surface. Runtime policy comes from the built-in role definitions in `schemas/agent.ts`.

## Role Shape

High-level behavior:

- `developer`: full code access, can propose patches, notes, and ticket mutations
- `reviewer`: full code access, cannot propose patches, can review and transition tickets
- `observer`: read-only and redacted where trust tier requires it
- `admin`: wildcard access

Avoid duplicating the full per-tool matrix in docs. The canonical source is the built-in role definition in code.

## Registration

Agents self-register with:

```text
register_agent(name, type?, desiredRole?, authToken?)
```

By default, registration is open and the requested built-in role is granted.

To harden registration, configure `.agora/config.json`:

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

- `observer` can remain open if `observerOpenRegistration` is `true`
- `developer`, `reviewer`, and `admin` require a matching `authToken`
- a role without a configured token is not self-registerable
- invalid registration fails with an error; it is not silently downgraded

Environment overrides:

- `AGORA_REGISTRATION_AUTH=true|false`
- `AGORA_OBSERVER_OPEN_REGISTRATION=true|false`
- `AGORA_ROLE_TOKEN_DEVELOPER=...`
- `AGORA_ROLE_TOKEN_REVIEWER=...`
- `AGORA_ROLE_TOKEN_OBSERVER=...`
- `AGORA_ROLE_TOKEN_ADMIN=...`

## Trust Tiers

Roles also imply trust tiers:

- `developer`, `reviewer`, `admin` -> Tier `A`
- `observer` -> Tier `B`

Tier controls evidence-bundle redaction and some higher-risk actions. See [trust-tiers.md](trust-tiers.md).

## Session Lifecycle

Every successful `register_agent` call creates:

- an `agents` row
- a new active `sessions` row

Sessions are the real actor handle for most stateful actions.

### What keeps a session alive

Any tool path that resolves an agent/session pair updates `lastActivity`.

In practice, that means actions like:

- patch proposal
- note proposal
- coordination calls
- ticket mutations
- file claims

all refresh the active session clock when they pass through `resolveAgent()`.

### Ending a session

`end_session(sessionId)`:

- marks the session as `disconnected`
- clears file claims
- removes it from active-session views

### Stale reaping

`HEARTBEAT_TIMEOUT_MS` is currently 10 minutes.

Stale session reaping happens in two places:

- `agent_status` list-all mode
- the dashboard maintenance loop, which runs every 60 seconds while the dashboard server is active

When a stale active session is reaped:

- the session becomes `disconnected`
- claimed files are released

This is the current behavior. It is not only an `agent_status` side effect anymore.

## Dashboard and Presence

The dashboard presence panel is an operational view, not the source of truth.

- source of truth: `sessions.state` + `lastActivity`
- presentation layer: online / idle / offline derived from age since last activity

The dashboard also hides sufficiently stale entries from the live-presence view to reduce noise.

## Practical Guidance

- use `observer` for safe read-only integrations
- use `developer` for implementation agents
- use `reviewer` for QA and workflow transitions
- reserve `admin` for explicit operational control
- if role hardening matters, do not leave `registrationAuth.enabled` off
