# Trust Tiers

## Tier A: Trusted Local Worker

Full access to bounded code spans. Subject to size limits and secret redaction.

## Tier B: Restricted External Worker

Receives pointers and sanitized summaries only. No raw code outbound.

## Permission Matrix

| Capability                      | Tier A              | Tier B                          |
|---------------------------------|---------------------|---------------------------------|
| Raw code in Evidence Bundles    | Yes (max 200 lines) | No — summaries + symbols only   |
| Propose patches                 | Yes                 | No                              |
| Propose notes                   | All types           | issue, decision only            |
| Read notes                      | All types           | issue, decision, change_note    |
| View event logs                 | Own + shared        | Own session only                |
| Cross-agent broadcast           | Yes                 | Receive only                    |
| File claims                     | Yes                 | No                              |
| Dashboard access                | Full                | Read-only agents + own logs     |

## Assignment

Tier is configured per-agent in the `agents` table or defaulted by role in the `roles` table.
