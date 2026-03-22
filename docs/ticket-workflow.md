# Ticket Workflow

This document captures the working conventions around Monsthera tickets.

The state machine exists in code, but the human workflow matters just as much:

- when a ticket is still design work
- when it is ready to implement
- when implementation must stop
- when QA should reopen vs create a new follow-up ticket

## States

| State | Meaning | Typical actor |
|---|---|---|
| `backlog` | Captured but not yet shaped | reviewer / admin |
| `technical_analysis` | Problem framing, design discussion, tradeoffs | reviewer / admin |
| `approved` | Ready to implement with enough clarity | reviewer / admin |
| `in_progress` | An agent is actively implementing | developer |
| `in_review` | Implementation is done and waiting for QA or reviewer validation | developer hands off, reviewer validates |
| `ready_for_commit` | Review passed and the slice is approved to land | reviewer / admin |
| `blocked` | Temporarily parked because of dependency, missing input, release hold, or external wait | developer / reviewer / admin |
| `resolved` | Accepted as complete | reviewer / admin |
| `closed` | Fully finished and no further action expected | reviewer / admin |
| `wont_fix` | Explicitly not being pursued | reviewer / admin |

Assignment is not its own status. Ownership lives in `assigneeAgentId`.

## State Machine

```mermaid
flowchart LR
    backlog --> technical_analysis
    backlog --> wont_fix

    technical_analysis --> backlog
    technical_analysis --> approved
    technical_analysis --> blocked
    technical_analysis --> wont_fix

    approved --> technical_analysis
    approved --> in_progress
    approved --> in_review
    approved --> blocked
    approved --> backlog
    approved --> wont_fix

    in_progress --> approved
    in_progress --> in_review
    in_progress --> blocked
    in_progress --> wont_fix

    in_review --> blocked
    ready_for_commit --> blocked
    blocked --> in_progress
    blocked --> technical_analysis
    blocked --> approved
    blocked --> in_review
    blocked --> ready_for_commit
    blocked --> backlog

    in_review --> in_progress
    in_review --> ready_for_commit

    ready_for_commit --> in_progress
    ready_for_commit --> resolved

    resolved --> in_progress
    resolved --> closed
```

## Canonical Handoff Rule

The most important convention is:

- implementation ends at `in_review`
- QA or reviewer decides what happens next

Recommended flow:

1. `technical_analysis`
2. `approved`
3. `in_progress`
4. `in_review`
5. `ready_for_commit`
6. `resolved`

This is partly social rather than perfectly enforced, so it must stay documented.

## Enforced Quorum Gates

Two workflow transitions are now enforced against council verdicts, not just documented:

- `technical_analysis -> approved`
- `in_review -> ready_for_commit`

Default enforcement rules:

- require `total council roles - 2` PASS verdicts
- `architect` and `security` FAIL verdicts act as vetoes
- `admin` remains the explicit bypass role

Operational flow:

1. reviewers submit structured verdicts via `submit_verdict`
2. anyone with access can inspect readiness via `check_consensus`
3. gated transitions fail with structured consensus details until quorum is satisfied

Repository-specific overrides live in `.monsthera/config.json` under `ticketQuorum`.

## QA Review Rules

When review finds a problem, choose between two paths:

### Reopen the same ticket

Move the ticket back to `in_progress` when:

- the issue is just unfinished work inside the same scope
- the intended acceptance criteria have not been met
- the fix belongs to the same implementation slice

### Open a follow-up bug ticket

Create a new ticket when:

- the bug is separable from the original slice
- it deserves its own priority or tracking
- it should not block acceptance of the original ticket directly

Practical rule:

- same scope rework -> back to `in_progress`
- distinct new defect -> new bug ticket, original can still progress independently

Administrative correction:

- use `in_progress -> approved` when a ticket was auto-started incorrectly and should return to the ready queue without being marked blocked
- use `approved -> technical_analysis` when an approval must be invalidated and sent back to council/design review
- use `* -> blocked` for a real temporary hold, not as a substitute for `backlog`; blocked tickets should carry a comment explaining the wait condition and be resumed to the appropriate queue once the blocker clears

## Technical Analysis Convention

Technical planning belongs in ticket comments using a structured header like:

```text
[Technical Analysis]
Summary
Current State
Constraints
Proposed Approach
Implementation Slices
Verification Plan
Risks
Open Questions
Compound Output
```

Backlog exit gate:

- a ticket must not leave `backlog` until the plan has at least `3` structured planning iterations
- those planning iterations must be authored by at least `2` distinct `provider/model` combinations
- Monsthera counts comments beginning with `[Technical Analysis]`, `[Plan Iteration]`, or `[Plan Review]` toward this gate

Only propose a ticket for implementation after analysis and review converge.

## Consensus and Readiness

A ticket is considered implementation-ready when:

- scope is bounded
- major risks are identified
- dependencies are clear
- acceptance criteria are testable
- reviewers no longer have unresolved design objections

That is the point where `technical_analysis` should become `approved`.

## Dependencies

Monsthera supports ticket-to-ticket relationships:

- `blocks`
- `relates_to`

`blocks` edges are validated to avoid cycles.

Use them to express:

- sequencing constraints
- prerequisites
- parallel but related work

Do not use dependency links as a substitute for status transitions.

## Product Boundary

The board is a visibility tool, not an authoritative workflow engine.

That means:

- ticket status should move through explicit agent actions and review decisions
- not by free-form drag-and-drop board manipulation

This keeps the workflow auditable and tied to real implementation progress.
