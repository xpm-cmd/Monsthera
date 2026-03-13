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
agora loop council TKT-1234abcd --transition in_review->ready_for_commit --json
```

Or for technical analysis:

```bash
agora loop council TKT-1234abcd --transition technical_analysis->approved --json
```

Use this when a reviewer needs the current ticket context and consensus state before writing findings or submitting a verdict.

What to do next:

- review only the current transition gate
- leave findings if there are concrete defects or risks
- submit a verdict only if the gate is actually ready

Prompt for a reviewer agent:

```text
Act as reviewer. Start by running `agora loop council TKT-1234abcd --transition in_review->ready_for_commit --json`.
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
agora loop dev --watch
agora loop council --watch
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

These loop commands now support both one-shot use and persistent watch mode.

They do not yet:

- keep a long-lived autonomous agent running by themselves
- automatically continue across multiple tool calls after the command returns
- replace human judgment for ambiguous product or design decisions

They are designed to make the next step obvious and consistent, not to hide the workflow.
