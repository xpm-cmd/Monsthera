# Agent Loop Commands

`agora loop` is the easiest way to start the repo-local planner, developer, and council workflows without manually registering agents or passing `agentId` and `sessionId`.

The command:

- registers the required built-in role
- runs the matching workflow
- in one-shot mode, ends the session automatically when the run finishes
- in watch mode, keeps the session alive, polls coordination, and repeats the loop until you stop it

Under the hood, it wraps the repo-local workflows in `.agora/workflows/` and the matching agent manifests in `.agora/agents/`.

## Available Commands

### Planner loop

Use this when you want Agora to inspect queues and tell the facilitator what needs orchestration next.
In watch mode it can also route the top `technical_analysis` or `in_review` ticket into the built-in quorum workflows.

```bash
agora loop plan
agora loop plan --limit 5 --json
agora facilitator
agora facilitator --watch
```

What it runs:

- workflow: `planner-loop`
- role: `facilitator`
- default agent name: `Planner Loop Facilitator`

Alias:

- `agora facilitator ...` maps to `agora loop plan ...`

What it returns:

- tickets in `backlog`
- tickets in `technical_analysis`
- tickets in `in_review`
- tickets in `ready_for_commit`
- tickets in `blocked`
- tickets in `approved`
- current repo capabilities and available review roles

### Developer loop

Use this when you want Agora to pick the next approved work item and preload implementation context.
In watch mode it can also auto-assign the top recommended approved ticket, claim its paths, and move it to `in_progress`.

```bash
agora loop dev
agora loop dev --limit 3 --json
```

What it runs:

- workflow: `developer-loop`
- role: `developer`
- default agent name: `Developer Loop`

What it returns:

- ranked suggestions from `suggest_next_work`
- the top suggested ticket
- a compact code pack centered on that ticket
- repo capabilities for the current implementation surface

### Council loop

Use this when a reviewer should enter a ticket review gate with ticket context and current consensus state already loaded.

```bash
agora loop council TKT-1234abcd --transition in_review->ready_for_commit --agent-name "Architect Reviewer"
agora loop council TKT-1234abcd --transition technical_analysis->approved --specialization security --json
agora loop council TKT-1234abcd --transition in_review->ready_for_commit --since-commit HEAD~1 --agent-name "Patterns Reviewer" --json
```

What it runs:

- workflow: `council-loop`
- role: `reviewer`
- default agent name: `Council Loop Reviewer`

Required inputs:

- `ticketId`
- `transition`

Allowed transitions:

- `technical_analysis->approved`
- `in_review->ready_for_commit`

Notes:

- ASCII `->` is accepted and normalized internally to the canonical `→` transition form.
- Council reviewers are specialization-scoped. Use either a specialized `--agent-name` such as `Architect Reviewer` or an explicit `--specialization`.
- `--since-commit` is optional and preloads recent change context when provided.
- `agora loop council --watch` can run without a fixed ticket and operate from the queue, but autonomous queue picking still requires a concrete specialization.

## Output Modes

Default mode prints a readable summary plus the workflow result payload.

```bash
agora loop plan
```

`--json` prints the loop wrapper plus the workflow result:

```bash
agora loop plan --json
agora facilitator --json
```

The JSON output includes:

- loop name
- workflow name
- registered agent identity for that run
- workflow result payload

## Optional Flags

All loop commands support:

```bash
--agent-name <name>
--json
--watch
--interval-ms <ms>
--max-runs <n>
```

Advanced identity overrides:

```bash
--agent-type <type>
--provider <provider>
--model <model>
--model-family <family>
--model-version <version>
```

If privileged self-registration is enabled for the target role, pass:

```bash
--auth-token <token>
```

## Recommended Human Usage

### Quick planning pass

```bash
agora loop plan --json
```

Use this first when you want to know:

- what is still sitting in backlog
- what is blocked
- what is waiting for review
- what is approved and ready for a developer

### Start implementation

```bash
agora loop dev --json
```

Use this after planning when you want Agora to suggest the best approved work item to take next.

### Prepare a council review

```bash
agora loop council TKT-e461224f --transition in_review->ready_for_commit --json
```

Use this before a reviewer starts writing findings or submitting a verdict.

### Keep a persistent loop alive

```bash
agora loop plan --watch
agora facilitator --watch
agora loop dev --watch
agora loop council --watch
```

What watch mode does:

- keeps one session alive
- polls coordination to maintain heartbeat
- repeats the loop every interval
- stops cleanly on `Ctrl+C`

Additional autonomous behavior in watch mode:

- planner watch can trigger `ta-review` for the top `technical_analysis` ticket
- planner watch can trigger `deep-review-v2` for the top `in_review` ticket
- developer watch can auto-take the top recommended `approved` ticket
- council watch still focuses on quorum gates and review requests; it does not synthesize verdicts by itself

Council watch priority order:

1. incoming `review_request`
2. tickets in `in_review`
3. tickets in `technical_analysis`
4. backlog planning when the higher-priority queues are empty

## Operational Notes

- The loop command now supports both one-shot runs and lightweight persistent watch workers.
- One-shot mode ends the session automatically after each invocation.
- Watch mode keeps the session active until you stop it.
- Planner and developer watch now perform safe state transitions where the underlying workflow/tooling already supports them.
- Council autonomy still depends on live reviewer agents submitting verdicts; the loop does not invent verdicts on its own.
- This CLI entrypoint keeps lifecycle hooks available but skips the background sweep timer, so loop workers do not inherit a shared interval.

## Related Files

- workflows: `.agora/workflows/`
- agent manifests: `.agora/agents/`
- CLI implementation: `src/cli/loops.ts`
- playbooks: `docs/playbooks.md`
