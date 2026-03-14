# Loop Playbooks

This document is the practical companion to [agent-loops.md](agent-loops.md).

Use it when you want a short operational recipe for a concrete situation:

- understand what needs attention now
- pick the next approved ticket to implement
- prepare a council review gate
- unblock work by turning a review blocker into a fix slice

## 1. I Want Agora To Tell Me What Needs Attention

Run:

```bash
agora loop plan --json
agora facilitator --json
```

Use this when you want a quick answer to:

- what is still in `backlog`
- what is stuck in `technical_analysis`
- what is waiting in `in_review`
- what is already `approved`
- what is blocked and may need a repair slice

What to do next:

- if there is `approved` work, route it to a developer
- if there is `in_review` work, route it to council
- if there is `blocked` work, inspect whether a child fix ticket is needed
- if a ticket is still in `backlog`, do not push it to `technical_analysis` until the plan has at least 3 structured iterations across 2 distinct models

Prompt for a facilitator agent:

```text
Act as facilitator. Start by running `agora loop plan --json`.
Use the result to identify the single highest-value next orchestration move.
Prefer: approved work that needs a developer, in_review work that needs council, or blocked work that needs a fix slice.
Do not patch code. Keep the output action-oriented.
```

## 2. I Want The Next Approved Ticket For Development

Run:

```bash
agora loop dev --json
```

Use this when you want Agora to:

- rank approved work
- surface the most likely next ticket
- preload compact code context

If you keep `agora loop dev --watch` running, it can also auto-take the top recommended approved ticket by assigning it, claiming paths, and moving it to `in_progress`.

What to do next:

- take the top suggested ticket unless there is a clear conflict
- move it to `in_progress` if needed
- implement the slice
- hand it off at `in_review`

Prompt for a developer agent:

```text
Act as developer. Start by running `agora loop dev --json`.
Take the top suggested approved ticket unless there is a strong reason not to.
Implement only that slice, validate the result, and hand it off in `in_review`.
If the work is blocked by a concrete defect or missing prerequisite, say so explicitly and propose or create the smallest repair slice.
```

## 3. I Want To Prepare A Council Review

Run:

```bash
agora loop council TKT-1234abcd --transition in_review->ready_for_commit --agent-name "Architect Reviewer" --json
```

Or for technical analysis:

```bash
agora loop council TKT-1234abcd --transition technical_analysis->approved --specialization security --json
```

Use this when a reviewer needs the current ticket context, deep evidence, and consensus state before writing findings or submitting a verdict.

What to do next:

- review only the current transition gate
- inspect the deep review note, historical context, code-pack hits, per-path complexity/coverage evidence, and generated recommendations first
- leave findings if there are concrete defects or risks
- submit a verdict only if the gate is actually ready

Prompt for a reviewer agent:

```text
Act as reviewer. Start by running `agora loop council TKT-1234abcd --transition in_review->ready_for_commit --agent-name "Architect Reviewer" --json`.
Review only the current gate. Focus on defects, regressions, risks, missing tests, and scope mismatches.
Be maximally detailed and analytically deep by default.
Do not propose patches.
If the ticket is ready, submit a verdict.
If it is blocked by a concrete fixable issue, identify the smallest repair slice.
```

Replace `TKT-1234abcd` and the transition with the real ticket and gate.

## 4. I Want To Unblock A Ticket With A Repair Slice

Use this flow when a review finds a concrete blocker that should not be solved by vague back-and-forth.

Recommended sequence:

1. run planner or council loop for the parent ticket
2. identify the exact blocker
3. open the smallest child ticket that repairs that blocker
4. link it to the parent
5. move the fix ticket through TA and implementation
6. re-review the parent after the child fix reaches `resolved`

Prompt for a facilitator agent:

```text
Act as facilitator. The parent ticket is blocked by a concrete issue.
Create the smallest repair slice that would unblock forward progress.
Link it to the parent, leave a short implementation plan in the comments, and keep the parent blocked until that fix slice is resolved.
```

## 5. I Want A Minimal Human Workflow

If you want the simplest manual routine, use this order:

```bash
agora loop plan --json
agora loop dev --json
agora loop council TKT-1234abcd --transition in_review->ready_for_commit --json
```

Meaning:

- `plan`: decide what should happen next
- `dev`: choose the best approved slice to implement
- `council`: evaluate a review or TA gate with current context loaded

## 6. I Want A Persistent Worker Instead Of Re-Running Commands Manually

Use watch mode:

```bash
agora loop plan --watch
agora facilitator --watch
agora loop dev --watch
agora loop council --watch --agent-name "Architect Reviewer"
agora loop council --watch --agent-name "Security Reviewer"
```

Recommended use:

- keep one planner session open in watch mode
- keep one developer session open in watch mode
- keep one or more council sessions open in watch mode

Council watch behavior:

- handles `review_request` first
- if no requests, looks at `in_review`
- if that queue is empty, looks at `technical_analysis`
- if that is also empty, falls back to backlog planning candidates
- each council worker only assigns and votes for its own specialization
- before voting, each council worker gathers historical context, dependency implications, code evidence, and per-path analysis, then posts a `[Deep Council Review]` note with recommendations

Planner watch behavior:

- inspects queues every cycle
- if there is `in_review` work, triggers `deep-review-v2`
- otherwise, if there is `technical_analysis` work, triggers `ta-review`

Developer watch behavior:

- inspects approved work every cycle
- if the top suggestion is unambiguous, auto-assigns it
- claims the ticket paths and moves it to `in_progress`
- meaningful completed cycles can append feedback to the configured `Retrospective` ticket

## 7. Recommended Operating Model

If you want separate agents working in parallel, use:

- one `facilitator` agent for planning and routing
- one `developer` agent for implementation
- one or more `reviewer` agents for council work

Map them to these commands:

- facilitator -> `agora loop plan --json`
- developer -> `agora loop dev --json`
- reviewer -> `agora loop council ... --json`

## 8. What These Commands Do Not Yet Do

These loop commands now support both one-shot use and persistent watch mode, and planner/developer watch can now advance some queue state automatically.

They still do not:

- replace the need for a live reviewer identity behind each specialization
- infer product intent or business tradeoffs that are not present in the repo, ticket, or stored knowledge
- replace human judgment for ambiguous product or design decisions
- fully implement code changes by themselves after a ticket reaches `in_progress`

They reduce manual orchestration, but council analysis and implementation still need real agents behind the loops.

## 9. Operational Checklists

Use these when the code and the ticket state may have drifted apart, or when a follow-up fix lands outside the original implementation wave.

### Ticket Reality Sync Checklist

- if implementation is already in the repo, do not leave the ticket in `approved`
- move it to `in_progress`, then `in_review`, so the state matches reality
- if review already passed and the code is landed, make sure the ticket reaches `resolved`
- prefer an exact commit-based transition path over a manual `resolved` that would attach the wrong `HEAD`
- verify with `agora ticket show TKT-1234abcd --json`

### Resolution Traceability Checklist

- confirm `commitSha` points to the actual landing commit, not the ticket creation `HEAD`
- for umbrella or multi-slice work, confirm `resolutionCommitShas` is populated
- if a post-commit reconcile is needed, prefer `agora ticket reconcile-commit --commit <sha> --json`
- if you are fixing historical metadata, leave an explicit `retro-sync` or `retro-audit` comment
- do not auto-resolve unrelated tickets just because they share nearby files; check overlap carefully first

### Loop And Routing Checklist

- if `suggest_next_work` says `review_manually`, the developer loop must not auto-take the ticket
- only auto-take when there is an explicit recommendation or a genuinely unambiguous candidate
- when adding a new routing heuristic, test clear match, ambiguous match, and no-claim cases
- re-run the focused loop tests before you trust the automation

### Indexing And Search Checklist

- if parser output changes, verify the extracted symbols are semantic identifiers, not raw AST text
- re-run focused parser and FTS tests
- run `agora index --incremental --verbosity quiet`
- treat new warnings during post-commit or reindex as regressions until explained
- if legacy indexed data can trigger warnings, sanitize it during rebuild instead of dropping the whole record
