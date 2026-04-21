# Migrating from Monsthera v2 to v3

v3 explicitly removed council / quorum / verdict primitives in favor of a 5-phase work article lifecycle with enrichment sections. If you arrived here with a v2 prompt, tutorial, or agent that references `decompose_goal`, `create_ticket`, `assign_council`, `submit_verdict`, `check_consensus`, `compute_waves`, `launch_convoy`, `add_protected_artifact`, or `export_audit`, this page is your map.

For the **why** behind these decisions, read [ADR-002 — Work Article Model](./adrs/002-work-article-model.md). This page is the **how**: how to translate a v2 workflow into the v3 surface.

---

## v2 → v3 primitive map

| v2 concept                             | v3 equivalent                                                        | Notes / caveats                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decompose_goal(goal)`                 | *(no direct replacement)*                                            | v3 treats decomposition as an orchestrator responsibility. Create work articles explicitly with `create_work` / `monsthera work create`.              |
| `create_ticket(title, …)`              | `create_work(title, template, …)` / `monsthera work create`          | Pick a template: `feature`, `bugfix`, `refactor`, or `spike`. Every work article starts in `planning`.                                                |
| `ticket.status = "triaged"`            | `advance_phase(id, "enrichment")` / `monsthera work advance`         | v3 collapses triaged + council-assigned + council-voting into the single `enrichment` phase.                                                          |
| `assign_council(ticket, [roles])`      | `enrichment_roles` frontmatter (set at creation via the template)    | Each template declares a default role list. Override with the template you pick or update frontmatter directly.                                       |
| `submit_verdict(ticket, agent, vote)`  | `contribute_enrichment(id, role, "contributed" or "skipped")` / `monsthera work enrich` | An enrichment contribution is not a yes/no vote; it's a record that a role wrote its analysis. Bodies go into `## <Role> Perspective` sections.        |
| `check_consensus(ticket)`              | `evaluate_readiness(id)` / `min_enrichment_met` guard                | Returns per-guard pass/fail. Use before `advance_phase` to decide if a guard skip is legitimate.                                                      |
| `quorum_reached(ticket)`               | *(not a concept in v3)*                                              | There is no voting. "Enough" is defined per-template by the number of contributions required for `min_enrichment_met`.                                |
| `veto_ticket(ticket)`                  | *(not a concept in v3)*                                              | Pre-commit hooks, reviewer guards (`all_reviewers_approved`), or a `skip_guard` audit record serve the same purpose.                                   |
| `compute_waves(tickets)`               | `plan_wave()` / `monsthera plan_wave`                                | v3 has the same concept but treats waves as emergent from the dep graph (`dependencies` / `blockedBy` frontmatter), not a stored object.               |
| `launch_convoy(wave)`                  | `execute_wave()` / orchestrator code outside Monsthera               | Monsthera lists ready articles; the orchestrator (Claude Code session, script, GitHub Actions job) actually runs them.                                |
| `assign_reviewer(ticket, agent)`       | `assign_reviewer(id, agentId)` / `monsthera work advance … review`   | Same primitive, renamed. Reviewers appear in the `reviewers` frontmatter and contribute via `## Review: <name>` body sections.                         |
| `approve_ticket(ticket, agent)`        | `submit_review(id, reviewerId, "approved")` / `monsthera work review` | A review verdict is a section-scoped record, not a ticket-scoped flag.                                                                                |
| `add_protected_artifact(path)`         | *(not a concept in v3)*                                              | Artifact protection was a policy layer on top of v2's council. In v3, use filesystem ACLs or a pre-commit hook; Monsthera does not guard files.       |
| `export_audit(ticket)`                 | `get_work(id).phaseHistory` + `get_events(workId: id)`               | Phase history lives in frontmatter; orchestration events (`phase_advanced`, `dependency_blocked`, …) live in the orchestration repo.                   |
| `ticket_state: "council-assigned"`     | `phase: "enrichment"`                                                | Collapsed into one phase. Role assignment is metadata, not a phase.                                                                                   |
| `ticket_state: "verdict-pending"`      | `phase: "enrichment"` + unmet `min_enrichment_met` guard             | "Waiting for verdicts" is now "waiting for enrichment contributions" and is surfaced by `evaluate_readiness`.                                         |
| `ticket_state: "review-pending"`       | `phase: "review"`                                                    | Straightforward rename. `submit_review` advances the per-reviewer section; the phase only advances to `done` when `all_reviewers_approved`.           |

---

## Idioms that no longer translate

Some v2 ideas are not available in v3 and should not be re-invented:

### 1. Quorum voting

v2 enforced a "N of M council members must approve" rule via `quorum_reached`. v3 removes voting entirely. Enrichment roles are **advisory** — each role writes an analysis section; the lead (or an orchestrator) decides when `min_enrichment_met` returns true and advances.

If your workflow depends on "at least 2 of 3 specialists agree", implement that in the orchestrator. Monsthera stores the contributions; it does not count them.

### 2. Absolute vetoes

There is no `veto_ticket` in v3. To approximate the effect:

- **Pre-commit / pre-advance hook** — run a custom script that inspects the work article's current state and fails the `advance_phase` call before it reaches Monsthera. The `skipGuard: { reason }` escape hatch is the one supported bypass, and every bypass is recorded on `phaseHistory`.
- **Reviewer guard (`all_reviewers_approved`)** — assign the person with veto power as a reviewer. Their `changes-requested` verdict blocks the review → done transition until a follow-up review flips it.
- **Filesystem ACLs / `git` protections** — the thing most teams actually want (e.g. "no direct commits to `main/`") is a VCS concern, not a work-lifecycle concern.

### 3. Waves-as-first-class

v2's `waves` was a stored, versioned collection of work items. v3 treats "what's ready to start" as a pure function of the dep graph:

```
ready(wave_n) = { w : w.phase == "planning" ∧ ∀d ∈ w.blockedBy: d.phase == "done" }
```

`plan_wave()` computes this on the fly. Agents (or dashboards) call it whenever they need a fresh ready-list. There is no "wave id" to reference, no wave state to mutate, and no way to "pin" a wave.

This is intentional: v2's stored waves drifted out of sync with ticket state constantly.

---

## Recommended workflow adaptations

### Modeling a council

In v2: `assign_council(ticket, ["security", "architecture", "testing"])` + wait for votes.

In v3:

1. Pick (or create) a work template whose default `enrichmentRoles` list matches your council composition.
2. `monsthera work create --title "…" --template feature --author orchestrator` — the article starts in `planning` with the roles registered but in `pending` status.
3. `monsthera work advance <id> --phase enrichment`.
4. Each specialist runs `monsthera work enrich <id> --role security --status contributed` (plus writes a `## Security Perspective` section via `monsthera work update --content-file <their-section>.md`).
5. When `min_enrichment_met` returns true, `monsthera work advance <id> --phase implementation`.

### Modeling waves

In v2: `compute_waves(tickets)` → `launch_convoy(wave_1)`.

In v3:

1. When creating a wave-2 article, pass `--blocked-by <wave-1-id-list>`. Monsthera verifies the ids exist and populates `blockedBy` frontmatter.
2. The orchestrator calls `plan_wave()` (or `monsthera plan_wave` via the MCP tool) to get the ready set.
3. For each ready article, the orchestrator spawns a subagent (Claude Code session, script, CI job) pointed at the article id.
4. On completion, the subagent calls `advance_phase(id, "done")` (or `monsthera work close --pr <n>`), and the next wave becomes ready.

See also: [Dependency concurrency — `docs/concurrency-model.md`](./concurrency-model.md) for the current single-writer constraint per article.

### Modeling a veto

See "Absolute vetoes" above. The three options compose — you can use all three on the same article.

### Modeling an audit export

In v2: `export_audit(ticket)` produced a CSV of every state change.

In v3:

```
monsthera work get <id>
# phaseHistory is right there in the frontmatter.
```

For cross-article events (dep blocks, reindex runs, etc.), use the `get_events` MCP tool with a `workId` filter. Both surfaces are append-only; nothing is redacted on archive (moving the file to `.monsthera/archive/…`).

---

## Where to file bugs about missing translations

If you hit a v2 workflow that cannot be expressed in v3 with any of the idioms above, open an issue with:

- The v2 primitive(s) you relied on.
- The workflow you were trying to express.
- The closest v3 primitive you found and why it falls short.

We'll either update this table, link an ADR, or — in rare cases — add a primitive.
