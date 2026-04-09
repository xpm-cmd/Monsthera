# Monsthera Review Package For Claude

This folder collects the current Monsthera v3 proposals and dashboard mockups in a repo-visible location so Claude can review them without depending on ignored folders.

## Contents

- `proposals/`
  Mirrored copies of the current Monsthera v3 planning and architecture docs originally kept in `MonstheraV3/`.
- `assets/export.pdf`
  Multi-page export of the **v1** dashboard mockups (does not include v2 redesigns).
- `assets/*.webp`
  Per-screen v1 exports for visual reference.
- `assets/v2/*.webp`
  Per-screen v2 redesign exports (dark mode). **These are the current proposal for the 5 redesigned screens.**
- `screen-manifest.json`
  Machine-friendly inventory of all screen names, ids, themes, and exported assets (v1 + v2).

## Proposal Docs

- `proposals/README.md`
- `proposals/monsthera-architecture-v6-final.md`
- `proposals/monsthera-ticket-as-article-design.md`
- `proposals/monsthera-v3-implementation-plan-final.md`

## Mockup Coverage

Included dashboard screens:

- Overview
- Flow
- Work
- Knowledge
- Search
- System
- Knowledge Graph
- Models & Runtime
- Agent Profiles
- Integrations
- Storage & Indexing
- Security & Permissions

Each exists in both light and dark mode (v1 proposal).

## v2 Redesign (dark mode)

Based on a critical UX/UI review, 5 screens were redesigned to address high-severity findings:

| Screen | Dark | Light | Findings Resolved |
|---|---|---|---|
| Overview v2 | `assets/v2/zs47R.webp` | `assets/v2/Igo7t.webp` | MEDIUM-3: Generic CTAs → specific actionable alerts |
| Flow v2 | `assets/v2/PE1fZ.webp` | `assets/v2/uaBjs.webp` | HIGH-1: 5 competing layers → 2-tier wave chips + agent table |
| Knowledge v2 | `assets/v2/byCV9.webp` | `assets/v2/2zPZc.webp` | HIGH-2: Wiki/Graph confusion → clean 3-column browser |
| Knowledge Graph v2 | `assets/v2/JssNL.webp` | `assets/v2/9rEyn.webp` | HIGH-2: Compressed graph → full-width canvas with on-demand panels |
| Security v2 | `assets/v2/x79BN.webp` | `assets/v2/7O2gs.webp` | MEDIUM-4 + HIGH-3: 6 blocks → tabbed layout, sidebar sub-nav |

Each v2 screen exists in both light and dark mode (10 screens total).

Design source: `/pencil-new.pen` (Pencil MCP)

**For review purposes, the v2 dark screens supersede their v1 counterparts:**
- v2 Overview Dark → replaces v1 Overview (light/dark)
- v2 Flow Dark → replaces v1 Flow (light/dark)
- v2 Knowledge Dark → replaces v1 Knowledge (light/dark)
- v2 Knowledge Graph Dark → replaces v1 Knowledge Graph (light/dark)
- v2 Security Dark → replaces v1 Security & Permissions (light/dark)

Screens **not** redesigned in v2 (keep v1 design): Work, Search, System, Models & Runtime, Agent Profiles, Integrations, Storage & Indexing.

## Review Notes

- **The exported webp assets are the primary review surface.** Read the images directly; do not depend on Pencil for review.
- The v1 editable source (`/pencil-halo.pen`) is no longer available — it was overwritten during the v2 design session. The v1 webp exports in `assets/` remain intact and are the only surviving v1 artifacts.
- The v2 editable source is `/pencil-new.pen` (Pencil MCP). Only the v2 screen ids (`zs47R`, `PE1fZ`, `byCV9`, `JssNL`, `x79BN`) are inspectable or modifiable through Pencil.
- The original `MonstheraV3/` folder remains ignored by git, but its contents are mirrored here under `proposals/`.
