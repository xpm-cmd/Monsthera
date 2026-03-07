# System Invariants

These rules are absolute. Every implementation decision must satisfy them.

## 1. All retrieval is commit-scoped

Every Evidence Bundle declares the commit it was generated against. No retrieval against uncommitted state.

## 2. All patches declare a base commit

A patch without `base_commit` is rejected at validation. This is the commit the patch was authored against.

## 3. No patch applies silently against a newer HEAD

If HEAD differs from `base_commit` at apply time, the patch is rejected as `stale`. The agent must re-fetch context and re-propose.

## 4. Every action is attributable to an agent and session

No anonymous tool calls. Unregistered agents get a default `anonymous` identity with observer-level permissions.

## 5. Every bundle and patch has provenance

Bundles have a `bundle_id` (deterministic hash of repo_id + commit + query + trust_tier). Patches reference the `bundle_id` they were based on. The provenance chain is traceable.

## 6. Trust tier and role are both enforced on reads and writes

Every tool call checks `(trust_tier, role)` before executing. Denied actions are logged with reason.

## 7. Reindex must complete before the next mutation cycle

No patch can be validated against an outdated index. The write queue blocks until reindex finishes and makes the new HEAD visible.
