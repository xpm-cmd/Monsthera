# Changelog

All notable changes to Agora are documented here.

## [Unreleased]

### Changed

- **Session heartbeat timeout** — `HEARTBEAT_TIMEOUT_MS` now defaults to 3 hours so long-running implementation sessions keep the same agent identity across review and commit workflows (`c4bbcef`)

## [1.0.0] — 2026-03-09

### QA Evolution (v1 → v12)

The v1.0.0 release went through 12 QA iterations improving search quality, agent coordination, and knowledge retrieval from a D+ to an A grade.

### Added

- **Semantic embeddings + CamelCase tokenization** — ONNX MiniLM-L6-v2 wired to `agora index`, CamelCase identifiers tokenized for FTS5 matching (`04313d7`)
- **Independent vector search for knowledge** — `search_knowledge` runs a full vector scan over all embeddings (cosine ≥ 0.6) in parallel with FTS5, discovering entries with zero keyword overlap (`a132110`)
- **Session lifecycle cleanup** — `end_session` tool for explicit session disconnect, `reapStaleSessions()` for automatic stale session expiry after `HEARTBEAT_TIMEOUT_MS` (initially 10 min in v1.0.0), claim release on disconnect (`3d789c4`)
- **Agent timestamps + diff stats** — `agent_status` includes session timestamps; `get_change_pack` includes per-commit diff stats (`1a4b491`)
- **Per-file diffs** — `get_change_pack` returns per-file unified diffs truncated to MAX_DIFF_LINES_PER_FILE = 50 lines (`2500a99`)
- **Observational `agent_status`** — no longer disconnects sessions as side effect; reaps stale sessions explicitly before building response (`a02dce6`, `3d789c4`)
- **Session count + visibility** — all sessions (active + disconnected) shown with timestamps and stale annotations (`9719cfb`)

### Changed

- **Evidence Bundle limits** — STAGE_A_MAX_CANDIDATES increased from 5 to 10, STAGE_B_MAX_EXPANDED from 3 to 5 (`f3d30d7`)
- **Dynamic search threshold** — scoped queries use MIN_RELEVANCE_SCORE_SCOPED = 0.15, unscoped use MIN_RELEVANCE_SCORE = 0.35 (`9719cfb`)
- **Query sanitization** — short queries (1-3 terms) use AND semantics, long queries (4+ terms) use OR with BM25 ranking (`0a4c3c1`)
- **Tool count** — 22 → 23 tools (added `end_session`)

### Fixed

- **Nonsense guard** — MIN_RELEVANCE_SCORE = 0.35 filters low-confidence results from evidence bundles (`eee95b8`)
- **WebSocket knowledge regression** — FTS5 AND semantics returned only 1 of 5 relevant knowledge entries; hybrid vector search recovered full recall (`a132110`)
- **Stale session accumulation** — swarm agents registered sessions but never disconnected; lifecycle cleanup reaps sessions inactive > 10 min in v1.0.0 (`3d789c4`)

### Constants Reference

| Constant | Value |
|----------|-------|
| STAGE_A_MAX_CANDIDATES | 10 |
| STAGE_B_MAX_EXPANDED | 5 |
| MAX_CODE_SPAN_LINES | 200 |
| MIN_RELEVANCE_SCORE | 0.35 |
| MIN_RELEVANCE_SCORE_SCOPED | 0.15 |
| MAX_DIFF_LINES_PER_FILE | 50 |
| HEARTBEAT_TIMEOUT_MS | 600,000 (10 min in v1.0.0) |
| CLAIM_RELEASE_TIMEOUT_MS | 300,000 (5 min) |

## [1.0.0-rc] — 2026-03-08

Initial release with 22 tools, FTS5 search, dashboard, knowledge store, Obsidian export.
