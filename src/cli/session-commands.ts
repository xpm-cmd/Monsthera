/* eslint-disable no-console */
import { agentId as makeAgentId, sessionId as makeSessionId } from "../core/types.js";
import { SessionStatus } from "../sessions/schemas.js";
import { formatError } from "./formatters.js";
import { parseFlag, withContainer } from "./arg-helpers.js";
import { printGroupHelp, printSubcommandHelp, wantsHelp } from "./help.js";
import type { Session } from "../sessions/repository.js";

// ─── Agent identity detection ─────────────────────────────────────────────────

/**
 * Resolve the agent ID from CLI flag, env var override, or auto-detection.
 *
 * Priority:
 *   1. Explicit `--agent <id>` flag
 *   2. `MONSTHERA_AGENT_ID` env var (user override in shell rc)
 *   3. Auto-detection from CLI/IDE env vars:
 *      - CLAUDECODE / CLAUDE_CODE_SESSION → "claude-code"
 *      - CODEX_HOME / CODEX_CLI            → "codex-cli"
 *   4. Fallback: "unknown"
 *
 * Hook usage typically omits `--agent` and relies on (2) or (3). Keeping
 * detection in the CLI (not the hook script) means the same logic runs for
 * direct invocations like `monsthera session list` without the hook.
 */
export function resolveAgentId(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const flag = parseFlag(args, "--agent");
  if (flag) return flag;
  if (env["MONSTHERA_AGENT_ID"]) return env["MONSTHERA_AGENT_ID"];
  if (env["CLAUDECODE"] || env["CLAUDE_CODE_SESSION"]) return "claude-code";
  if (env["CODEX_HOME"] || env["CODEX_CLI"]) return "codex-cli";
  return "unknown";
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function handleSession(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (subcommand === undefined || wantsHelp([subcommand])) {
    printGroupHelp({
      command: "monsthera session",
      summary:
        "Manage agent session lifecycle (cognitive handoff layer; see docs/agent-bootstrap-guide.md).",
      subcommands: [
        { name: "open", summary: "Open a new session (auto-supersedes prior open for same agent+repo)." },
        { name: "close", summary: "Close the current session and persist Stage A facts." },
        { name: "get", summary: "Fetch a session by id." },
        { name: "list", summary: "List sessions filtered by agent / status / repo." },
      ],
    });
    return;
  }

  switch (subcommand) {
    case "open":
      await handleSessionOpen(subArgs);
      break;
    case "close":
      await handleSessionClose(subArgs);
      break;
    case "get":
      await handleSessionGet(subArgs);
      break;
    case "list":
      await handleSessionList(subArgs);
      break;
    case "_generate-handoff":
      // Internal subcommand: invoked by the async worker subprocess. Not
      // listed in the public help. Idempotent — safe to retry by hand.
      await handleSessionGenerateHandoff(subArgs);
      break;
    default:
      console.error(`Unknown session subcommand: ${subcommand}`);
      console.error('Run "monsthera session --help" for usage.');
      process.exit(1);
  }
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handleSessionOpen(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera session open",
      summary: "Open a new session. Auto-supersedes any prior open session for the same agent+repo.",
      usage: "[--agent <id>] [--intent <text>] [--branch <name>] [--teaser-only | --json] [--repo <path>]",
      flags: [
        { name: "--agent <id>", description: "Agent identity. Defaults to env detection (CLAUDECODE → claude-code, CODEX_* → codex-cli) with MONSTHERA_AGENT_ID override." },
        { name: "--intent <text>", description: "Optional one-line intent statement for this session." },
        { name: "--branch <name>", description: "Git branch at open time. Defaults to null." },
        { name: "--teaser-only", description: "Emit only the human-readable teaser to stdout (for SessionStart hook use)." },
        { name: "--json", description: "Emit the Session record as JSON." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      examples: [
        "monsthera session open                        # auto-detect agent, emit JSON",
        "monsthera session open --teaser-only          # for SessionStart hook",
        'monsthera session open --intent "Land M3 phase 5"',
      ],
    });
    return;
  }

  await withContainer(args, async (container) => {
    const agent = resolveAgentId(args);
    const intent = parseFlag(args, "--intent") ?? null;
    const branch = parseFlag(args, "--branch") ?? null;
    const teaserOnly = args.includes("--teaser-only");
    const asJson = args.includes("--json");

    const result = await container.sessionService.open({
      agentId: makeAgentId(agent),
      repo: container.config.repoPath,
      branch,
      intent,
    });

    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    if (teaserOnly) {
      process.stdout.write(
        formatTeaser(result.value.session, result.value.parent, result.value.previousOrphan) + "\n",
      );
      return;
    }

    if (asJson) {
      process.stdout.write(JSON.stringify(result.value.session, null, 2) + "\n");
      return;
    }

    process.stdout.write(formatSession(result.value.session) + "\n");
    if (result.value.superseded !== null) {
      process.stdout.write(`\nSuperseded prior open session: ${result.value.superseded.id}\n`);
    }
    if (result.value.previousOrphan !== null) {
      process.stdout.write(
        `\n⚠ Previous session ${result.value.previousOrphan.id} closed without a handoff article — the worker did not finish. ` +
          `Re-run: \`monsthera session _generate-handoff ${result.value.previousOrphan.id}\`\n`,
      );
    }
  });
}

async function handleSessionClose(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera session close",
      summary: "Close the current session. Persists Stage A facts to disk.",
      usage: "[--session-id <id>] [--note <text>] [--agent <id>] [--repo <path>] [--json]",
      flags: [
        { name: "--session-id <id>", description: "Explicit session to close. If absent, the open session for (agent, repo) is resolved." },
        { name: "--note <text>", description: "Optional one-line agent intent note. Persisted on facts.agentNote." },
        { name: "--no-llm", description: "Skip Stages B/C/D. Persist a T1-only handoff article (Ollama-free) inline." },
        { name: "--sync", description: "Run the LLM pipeline inline and wait for it (~5-60s). Default is fire-and-forget." },
        { name: "--agent <id>", description: "Used with implicit close. Defaults to env detection." },
        { name: "--json", description: "Emit the closed Session record as JSON." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "Default behavior: async fire-and-forget. The session is marked `closed` immediately (~100ms) and a detached worker subprocess generates the handoff article in the background (~30-60s on Ollama).",
        "Use --sync when you need to read the article inline (e.g. CI smoke tests, debugging).",
        "Use --no-llm when Ollama is unavailable; the resulting handoff has Hypergraph + Facts but no narrative. This forces sync mode.",
        "Closing an abandoned session errors out — that history is finalized.",
        "If the async worker crashes, the next `session open` surfaces an orphan warning. To recover, re-run with `--sync` or call `session _generate-handoff <id>` directly.",
      ],
      examples: [
        "monsthera session close",
        'monsthera session close --note "Land M3 phase 5"',
      ],
    });
    return;
  }

  await withContainer(args, async (container) => {
    const sessionIdRaw = parseFlag(args, "--session-id");
    const note = parseFlag(args, "--note") ?? null;
    const noLlm = args.includes("--no-llm");
    const sync = args.includes("--sync");
    const asJson = args.includes("--json");

    const closeInput =
      sessionIdRaw !== undefined
        ? { sessionId: makeSessionId(sessionIdRaw), note, noLlm, sync }
        : {
            agentId: makeAgentId(resolveAgentId(args)),
            repo: container.config.repoPath,
            note,
            noLlm,
            sync,
          };

    const result = await container.sessionService.close(closeInput);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          {
            session: result.value.session,
            facts: result.value.facts,
            handoffArticleId: result.value.handoffArticleId,
            degraded: result.value.degraded,
            asyncDispatched: result.value.asyncDispatched,
            evalScore: result.value.evalResult?.score ?? null,
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    process.stdout.write(formatSession(result.value.session) + "\n");
    process.stdout.write(`\nFacts persisted: ${result.value.session.factsPath}\n`);
    if (result.value.asyncDispatched) {
      process.stdout.write(
        `Handoff article: pending (async worker generating in background — check back with \`monsthera session get ${result.value.session.id}\`)\n`,
      );
    } else if (result.value.handoffArticleId !== null) {
      process.stdout.write(`Handoff article: ${result.value.handoffArticleId}`);
      if (result.value.degraded) {
        process.stdout.write(" (degraded — Ollama unavailable or --no-llm)\n");
      } else {
        const score = result.value.evalResult?.score;
        process.stdout.write(score !== undefined ? ` (quality ${score}/5)\n` : "\n");
      }
    } else {
      process.stdout.write(
        "Handoff article: NOT generated (worker dispatch failed). The next `session open` will surface an orphan warning.\n",
      );
    }
  });
}

async function handleSessionGenerateHandoff(args: string[]): Promise<void> {
  // Internal subcommand — invoked by the async worker subprocess. Surface
  // a minimal JSON line on stdout for logging / debugging; on failure write
  // to stderr but exit 0 so the parent process never sees a non-zero exit
  // (the parent has already returned by this point in async mode).
  const idArg = args.find((a) => !a.startsWith("-"));
  if (!idArg) {
    console.error("session _generate-handoff: missing session id");
    process.exit(0);
  }
  await withContainer(args, async (container) => {
    const result = await container.sessionService.generateHandoff(makeSessionId(idArg));
    if (!result.ok) {
      console.error(`session _generate-handoff failed: ${result.error.code} ${result.error.message}`);
      process.exit(0);
    }
    process.stdout.write(
      JSON.stringify({
        sessionId: result.value.session.id,
        handoffArticleId: result.value.handoffArticleId,
        qualityScore: result.value.evalResult?.score ?? null,
        degraded: result.value.degraded,
      }) + "\n",
    );
  });
}

async function handleSessionGet(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera session get",
      summary: "Fetch a session by id.",
      usage: "<session-id> [--json] [--repo <path>]",
      flags: [
        { name: "--json", description: "Emit raw JSON." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      examples: ["monsthera session get ses-20260512-1043-claude-code"],
    });
    return;
  }

  const idArg = args.find((a) => !a.startsWith("-"));
  if (!idArg) {
    console.error("Missing required positional: <session-id>");
    process.exit(1);
  }

  await withContainer(args, async (container) => {
    const result = await container.sessionService.get(makeSessionId(idArg));
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    if (args.includes("--json")) {
      process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
      return;
    }
    process.stdout.write(formatSession(result.value) + "\n");
  });
}

async function handleSessionList(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera session list",
      summary: "List sessions, newest first.",
      usage: "[--agent <id>] [--status <s>] [--limit <n>] [--json] [--repo <path>]",
      flags: [
        { name: "--agent <id>", description: "Filter by agent id." },
        { name: "--status <s>", description: "open | closed | abandoned" },
        { name: "--limit <n>", description: "Max results.", default: "all" },
        { name: "--json", description: "Emit raw JSON." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
    });
    return;
  }

  await withContainer(args, async (container) => {
    const agent = parseFlag(args, "--agent");
    const status = parseFlag(args, "--status");
    const limit = parseFlag(args, "--limit");

    const statusFilter =
      status === SessionStatus.OPEN || status === SessionStatus.CLOSED || status === SessionStatus.ABANDONED
        ? status
        : undefined;
    const filter = {
      ...(agent ? { agentId: makeAgentId(agent) } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(limit ? { limit: parseInt(limit, 10) } : {}),
    };

    const result = await container.sessionService.list(filter);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    if (args.includes("--json")) {
      process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
      return;
    }
    if (result.value.length === 0) {
      process.stdout.write("(no sessions)\n");
      return;
    }
    for (const s of result.value) {
      process.stdout.write(formatSessionLine(s) + "\n");
    }
  });
}

// ─── Helpers (formatting + teaser) ────────────────────────────────────────────

function formatSession(s: Session): string {
  const lines: string[] = [
    `ID:        ${s.id}`,
    `Agent:     ${s.agentId}`,
    `Repo:      ${s.repo}`,
    `Branch:    ${s.branch ?? "(none)"}`,
    `Status:    ${s.status}`,
    `Opened:    ${s.openedAt}`,
  ];
  if (s.closedAt) lines.push(`Closed:    ${s.closedAt}`);
  if (s.parentSessionId) lines.push(`Parent:    ${s.parentSessionId}`);
  if (s.intent) lines.push(`Intent:    ${s.intent}`);
  if (s.handoffArticleId) lines.push(`Handoff:   ${s.handoffArticleId}`);
  if (s.factsPath) lines.push(`Facts:     ${s.factsPath}`);
  if (s.abandonReason) lines.push(`Reason:    ${s.abandonReason}`);
  if (s.quality.score !== null || s.quality.degraded || s.quality.model !== null) {
    lines.push(
      `Quality:   score=${s.quality.score ?? "?"} degraded=${s.quality.degraded} model=${s.quality.model ?? "?"}`,
    );
  }
  return lines.join("\n");
}

function formatSessionLine(s: Session): string {
  const opened = s.openedAt.slice(0, 16).replace("T", " ");
  return `${s.id}  ${s.status.padEnd(10)}  ${s.agentId.padEnd(14)}  opened=${opened}`;
}

/**
 * Build the human-readable teaser emitted by `session open --teaser-only` and
 * inlined under the `## Monsthera briefing` heading by the SessionStart hook.
 *
 * Phase 1 ships a minimal teaser: enough to confirm the protocol is working
 * and to point at the prior session id. The richer teaser (TL;DR, nextSteps,
 * cross-agent delta) lands in a follow-up alongside the handoff-renderer.
 */
function formatTeaser(current: Session, parent: Session | null, orphan: Session | null): string {
  const closeHint =
    `→ Before exit / on \"cierra session\" / \"close session\": ` +
    `\`monsthera session close --note \"<one-line intent>\"\` ` +
    `(returns in ~100ms, Ollama runs in background).`;

  if (parent === null) {
    return [
      `No previous handoff for ${current.agentId} in this repo. Starting fresh (session ${current.id}).`,
      closeHint,
    ].join("\n");
  }
  const closedAt = parent.closedAt ? parent.closedAt.slice(0, 16).replace("T", " ") : "(unknown)";
  const lines: string[] = [
    `**Last session** ${parent.id} (${parent.agentId}, closed ${closedAt}).`,
    `**This session**: ${current.id}.`,
  ];
  if (orphan !== null) {
    lines.push(
      `⚠ Previous handoff is incomplete — the async worker did not finish. ` +
        `Recover: \`monsthera session _generate-handoff ${orphan.id}\``,
    );
  } else if (parent.handoffArticleId) {
    lines.push(`→ \`monsthera knowledge get ${parent.handoffArticleId}\` for the previous handoff.`);
  }
  lines.push(closeHint);
  return lines.join("\n");
}

