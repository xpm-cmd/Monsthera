import type { SessionService, BriefDepth } from "../sessions/service.js";
import { SessionStatus } from "../sessions/schemas.js";
import {
  agentId as makeAgentId,
  sessionId as makeSessionId,
  timestamp as makeTimestamp,
} from "../core/types.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import {
  errorResponse,
  isErrorResponse,
  optionalNumber,
  optionalString,
  requireString,
  successResponse,
} from "./validation.js";

export interface SessionToolDeps {
  readonly sessionService: SessionService;
}

const VALID_DEPTHS: ReadonlySet<string> = new Set(["teaser", "standard", "full"]);
const VALID_STATUSES: ReadonlySet<string> = new Set([
  SessionStatus.OPEN,
  SessionStatus.CLOSED,
  SessionStatus.ABANDONED,
]);

export function sessionToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "session_open",
      description:
        "Open a new agent session. Auto-supersedes any prior open session for the same (agentId, repo). Returns the new Session record plus the parent (last closed) and any orphan handoff that did not finish. When to use: First call of an agent session, before any work begins, so the handoff chain stays unbroken; the returned parent handoff is your warm-start context.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agentId: { type: "string", description: "Agent identity (required)" },
          repo: { type: "string", description: "Repository absolute path. Defaults to the container's repo path if omitted." },
          intent: { type: "string", description: "Optional one-line intent statement for this session" },
          branch: { type: "string", description: "Git branch at open time" },
        },
        required: ["agentId"],
      },
    },
    {
      name: "session_close",
      description:
        "Close an open session and persist the Stage A facts artifact. ADR-019 PREFERRED: pass `content` (full handoff body authored by you, the executing agent) — synchronous, skips the LLM pipeline entirely, produces a higher-quality handoff because the writer has full session context. LEGACY: pass `note` (short string) + leave `content` empty → triggers the local-Ollama pipeline (Stages B/C/D) which expands the note into a structured handoff. Returns immediately when `sync` is false (default, legacy path only); the LLM pipeline runs in the background. Set `sync: true` to wait for the full handoff to be persisted (useful in tests and programmatic flows). Agent-direct (`content`) is always synchronous. When to use: Last call of a session, after outcomes are settled — close promptly so the next session_open finds a parent handoff instead of an orphan.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string", description: "Specific session to close. Mutually exclusive with agentId+repo." },
          agentId: { type: "string", description: "Resolve the open session by agent (requires repo too)" },
          repo: { type: "string", description: "Repository path used with agentId to resolve the open session" },
          content: { type: "string", description: "(ADR-019 PREFERRED) Full handoff body authored by the executing agent. Markdown: TL;DR + What happened + What's next + Decisions + Blockers. The CLI prepends the session header and appends Hypergraph + Facts. Skips the LLM pipeline entirely (writer=agent, no Ollama, no degraded mode). Mutually-supersedes the `note`+LLM path — if `content` is non-empty, `note` is still persisted to facts.agentNote for grounding but the rendered body comes from `content`." },
          note: { type: "string", description: "(LEGACY) One-line agent intent. Triggers the Ollama pipeline that expands it into a structured handoff. Lower-utility than `content` because the LLM can only re-format what the note already said; specifics not in the note are lost. See ADR-019 for rationale to prefer `content`." },
          noLlm: { type: "boolean", description: "Skip Stages B/C/D — persist a T1-only handoff article. Implied when `content` is provided." },
          sync: { type: "boolean", description: "Wait for the LLM pipeline to finish before returning. Ignored when `content` is provided (agent-direct is always sync)." },
        },
      },
    },
    {
      name: "session_get",
      description: "Fetch a session record by id. When to use: When you hold a session id from session_list or an open/close response and need the raw lifecycle record; for the handoff content itself, use session_brief.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string", description: "Session id" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "session_list",
      description: "List sessions newest-first with optional filters. When to use: To locate session ids, spot an agent's open or abandoned sessions before cleanup, or reconstruct a cross-agent timeline for a repo.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agentId: { type: "string", description: "Filter by agent id" },
          repo: { type: "string", description: "Filter by repository path" },
          status: { type: "string", enum: ["open", "closed", "abandoned"], description: "Filter by lifecycle status" },
          limit: { type: "number", description: "Maximum results" },
        },
      },
    },
    {
      name: "session_brief",
      description:
        "Read-side complement to session_open --teaser-only. Returns a depth-sliced view of a session's handoff article so a running agent can re-orient mid-flight. Provide either sessionId, or agentId+repo (resolves to the latest closed session). When to use: Mid-session after context loss (compaction, a long pause), or to peek at another agent's latest handoff without opening a session of your own.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: { type: "string", description: "Brief this exact session. Mutually exclusive with agentId+repo." },
          agentId: { type: "string", description: "Brief the latest closed session for this agent in repo" },
          repo: { type: "string", description: "Repository path used with agentId" },
          depth: { type: "string", enum: ["teaser", "standard", "full"], description: "Slice level. Default: standard" },
          since: { type: "string", description: "ISO timestamp. When set, populates crossAgentDelta with counts of CLOSED sessions by OTHER agents in repo since this time." },
        },
      },
    },
  ];
}

export async function handleSessionTool(
  name: string,
  args: Record<string, unknown>,
  deps: SessionToolDeps,
): Promise<ToolResponse> {
  switch (name) {
    case "session_open": {
      const agent = requireString(args, "agentId");
      if (isErrorResponse(agent)) return agent;
      const repoOpt = optionalString(args, "repo", 1024);
      if (isErrorResponse(repoOpt)) return repoOpt;
      const intentOpt = optionalString(args, "intent", 1024);
      if (isErrorResponse(intentOpt)) return intentOpt;
      const branchOpt = optionalString(args, "branch", 256);
      if (isErrorResponse(branchOpt)) return branchOpt;
      const repo = repoOpt ?? "";
      if (!repo) {
        return errorResponse("VALIDATION_FAILED", "session_open requires `repo`");
      }
      const result = await deps.sessionService.open({
        agentId: makeAgentId(agent),
        repo,
        intent: intentOpt ?? null,
        branch: branchOpt ?? null,
      });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }

    case "session_close": {
      const sessionIdArg = optionalString(args, "sessionId");
      if (isErrorResponse(sessionIdArg)) return sessionIdArg;
      const agentArg = optionalString(args, "agentId");
      if (isErrorResponse(agentArg)) return agentArg;
      const repoArg = optionalString(args, "repo", 1024);
      if (isErrorResponse(repoArg)) return repoArg;
      const noteArg = optionalString(args, "note", 1024);
      if (isErrorResponse(noteArg)) return noteArg;
      // ADR-019 agent-direct content. Long body allowed (handoffs commonly
      // run 2-4KB; cap at 64KB for sanity — a body that big almost certainly
      // means the agent dumped raw logs).
      const contentArg = optionalString(args, "content", 64 * 1024);
      if (isErrorResponse(contentArg)) return contentArg;
      const noLlm = args["noLlm"] === true;
      const sync = args["sync"] === true;
      if (!sessionIdArg && !(agentArg && repoArg)) {
        return errorResponse(
          "VALIDATION_FAILED",
          "session_close requires either sessionId, or both agentId and repo",
        );
      }
      const result = await deps.sessionService.close({
        ...(sessionIdArg ? { sessionId: makeSessionId(sessionIdArg) } : {}),
        ...(agentArg ? { agentId: makeAgentId(agentArg) } : {}),
        ...(repoArg ? { repo: repoArg } : {}),
        note: noteArg ?? null,
        content: contentArg ?? null,
        noLlm,
        sync,
      });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }

    case "session_get": {
      const id = requireString(args, "sessionId");
      if (isErrorResponse(id)) return id;
      const result = await deps.sessionService.get(makeSessionId(id));
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }

    case "session_list": {
      const agentArg = optionalString(args, "agentId");
      if (isErrorResponse(agentArg)) return agentArg;
      const repoArg = optionalString(args, "repo", 1024);
      if (isErrorResponse(repoArg)) return repoArg;
      const statusArg = optionalString(args, "status");
      if (isErrorResponse(statusArg)) return statusArg;
      const limit = optionalNumber(args, "limit", 1, 10_000);
      if (isErrorResponse(limit)) return limit;
      if (statusArg !== undefined && !VALID_STATUSES.has(statusArg)) {
        return errorResponse(
          "VALIDATION_FAILED",
          `Invalid status: ${statusArg}. Must be one of: ${[...VALID_STATUSES].join(", ")}`,
        );
      }
      const result = await deps.sessionService.list({
        ...(agentArg ? { agentId: makeAgentId(agentArg) } : {}),
        ...(repoArg ? { repo: repoArg } : {}),
        ...(statusArg ? { status: statusArg as SessionStatus } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({ sessions: result.value });
    }

    case "session_brief": {
      const sessionIdArg = optionalString(args, "sessionId");
      if (isErrorResponse(sessionIdArg)) return sessionIdArg;
      const agentArg = optionalString(args, "agentId");
      if (isErrorResponse(agentArg)) return agentArg;
      const repoArg = optionalString(args, "repo", 1024);
      if (isErrorResponse(repoArg)) return repoArg;
      const depthOpt = optionalString(args, "depth");
      if (isErrorResponse(depthOpt)) return depthOpt;
      const sinceArg = optionalString(args, "since");
      if (isErrorResponse(sinceArg)) return sinceArg;
      const depthArg = depthOpt ?? "standard";
      if (!VALID_DEPTHS.has(depthArg)) {
        return errorResponse(
          "VALIDATION_FAILED",
          `Invalid depth: ${depthArg}. Must be one of: teaser, standard, full`,
        );
      }
      if (!sessionIdArg && !(agentArg && repoArg)) {
        return errorResponse(
          "VALIDATION_FAILED",
          "session_brief requires either sessionId, or both agentId and repo",
        );
      }
      const result = await deps.sessionService.brief({
        depth: depthArg as BriefDepth,
        ...(sessionIdArg ? { sessionId: makeSessionId(sessionIdArg) } : {}),
        ...(agentArg ? { agentId: makeAgentId(agentArg) } : {}),
        ...(repoArg ? { repo: repoArg } : {}),
        ...(sinceArg ? { since: makeTimestamp(sinceArg) } : {}),
      });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }

    default:
      return errorResponse("UNKNOWN_TOOL", `Unknown session tool: ${name}`);
  }
}
