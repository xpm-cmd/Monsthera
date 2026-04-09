# Monsthera Review Package

Dashboard UI proposal for Monsthera v3, with architecture docs and exported screen mockups.

## Contents

- `proposals/` — Architecture and domain model docs mirrored from `MonstheraV3/`.
- `assets/v2/*.webp` — v2 redesigned screens (light + dark). **Current proposal.**
- `assets/*.webp` — v1 screens not yet redesigned (Work, Search, System, Settings).
- `screen-manifest.json` — Machine-friendly screen inventory.
- `design/EDITABLE-SOURCE.md` — Pencil MCP source reference.

## Proposal Docs

- `proposals/monsthera-architecture-v6-final.md`
- `proposals/monsthera-ticket-as-article-design.md`
- `proposals/monsthera-v3-implementation-plan-final.md`

## v2 Redesigned Screens

Based on a critical UX/UI review, 5 screens were redesigned (light + dark = 10 screens):

| Screen | Dark | Light | Findings Resolved |
|---|---|---|---|
| Overview v2 | `assets/v2/zs47R.webp` | `assets/v2/Igo7t.webp` | MEDIUM-3: Generic CTAs → specific actionable alerts |
| Flow v2 | `assets/v2/PE1fZ.webp` | `assets/v2/uaBjs.webp` | HIGH-1: 5 competing layers → 2-tier wave chips + agent table |
| Knowledge v2 | `assets/v2/byCV9.webp` | `assets/v2/2zPZc.webp` | HIGH-2: Wiki/Graph confusion → clean 3-column browser |
| Knowledge Graph v2 | `assets/v2/JssNL.webp` | `assets/v2/9rEyn.webp` | HIGH-2: Compressed graph → full-width canvas with on-demand panels |
| Security v2 | `assets/v2/x79BN.webp` | `assets/v2/7O2gs.webp` | MEDIUM-4 + HIGH-3: 6 blocks → tabbed layout, sidebar sub-nav |

Design source: `/pencil-new.pen` (Pencil MCP). All v2 screen ids are editable.

## v1 Screens (not redesigned)

These screens retain their original v1 design (light + dark):

- Work, Search, System, Models & Runtime, Agent Profiles, Integrations, Storage & Indexing

Their Pencil source is no longer available — the exported webp files are the only artifacts.

## Review Notes

- **The exported webp assets are the primary review surface.**
- v2 screens in `/pencil-new.pen` are editable via Pencil MCP using the ids in `screen-manifest.json`.
- v1 screens are export-only (not editable). Their Pencil source was lost during the v2 design session.
