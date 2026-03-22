# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Monsthera, **do not open a public issue**. Instead, please report it privately:

1. **Email:** Open a private security advisory on GitHub via the [Security Advisories](https://github.com/xpm-cmd/Monsthera/security/advisories/new) page
2. Include: description of the vulnerability, steps to reproduce, and potential impact
3. You will receive a response within 72 hours

## Security Model

Monsthera is designed to run **locally** on the developer's machine. It does not expose services to the public internet by default.

### Trust Tiers

| Tier | Access | Use Case |
|------|--------|----------|
| **A** | Full code spans, unrestricted queries | Trusted local agents |
| **B** | Redacted code, metadata only | Untrusted or remote agents |

### Secret Detection

Monsthera scans indexed files for sensitive patterns and prevents exposure:

- API keys (`sk_`, `pk_`, AWS `AKIA` prefixes)
- GitHub tokens (`ghp_`, `ghs_`)
- Private keys (PEM format)
- Connection strings (database URIs)
- Generic secrets (password/token assignments)

Files matching sensitive patterns (`.env`, `*.key`, `*.pem`, `credentials.*`) are flagged during indexing and redacted for Tier B agents.

### Agent Roles

| Role | Capabilities |
|------|-------------|
| `developer` | Full read/write: code, patches, notes, knowledge |
| `reviewer` | Read code + propose notes; no patches |
| `observer` | Read-only access |
| `admin` | Full access including agent management |

### Dashboard

The admin dashboard binds to `localhost` and is intended for local use only. It serves an HTML interface with real-time SSE updates.

### Event Logging

All tool invocations are logged with:
- SHA-256 hashed input/output (raw payloads are not stored by default)
- Agent attribution (who did what)
- Timestamp and duration
- Optional debug payload capture with 24-hour TTL

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Scope

This security policy covers the Monsthera MCP server, CLI, dashboard, and all published npm packages. It does not cover third-party MCP clients or integrations.
