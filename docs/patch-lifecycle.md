# Patch Lifecycle

## State Machine

```
proposed → validated → applied → committed
    ↓          ↓          ↓
  failed     stale      failed
```

## Rules

1. Every patch includes a `base_commit` — the HEAD when the patch was authored
2. Validation checks `base_commit` against current HEAD
3. If HEAD ≠ base_commit → status `stale`, agent must re-fetch and re-propose
4. `dry_run=true` runs full validation without applying
5. One active apply per work item — serialized through a write queue
6. After successful commit, reindex triggers and blocks further mutations (invariant 7)
7. Failed applies never corrupt index state

## File Claims

- Agents can call `claim_files([paths])` to signal intent
- Other agents see claimed files in `status()` response
- Proposing a patch touching claimed files emits a warning (not a hard block)
- Claims are released on:
  - Explicit release (via `claim_files` with empty paths)
  - `end_session` call (immediately disconnects session and clears claims)
  - Automatic stale reaping (sessions inactive > `HEARTBEAT_TIMEOUT_MS` = 60 min)
  - Patch commit

## Provenance

- Patch proposals reference the `bundle_id` of the Evidence Bundle used for context
- This creates an auditable chain: query → bundle → patch → commit
