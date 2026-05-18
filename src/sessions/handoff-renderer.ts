import * as path from "node:path";
import type { Session } from "./repository.js";
import type { SessionFacts } from "./schemas.js";
import type { LLMSummary } from "./llm-summarizer.js";

// ─── Identity helpers ────────────────────────────────────────────────────────

export function buildHandoffSlug(session: Session): string {
  return `handoff-${session.id}`;
}

export function buildHandoffTitle(session: Session): string {
  const date = session.openedAt.slice(0, 10);
  const duration = computeDurationMinutes(session);
  return `Handoff: ${date} ${session.agentId} (${duration} min)`;
}

export function buildHandoffTags(session: Session): string[] {
  return ["session-handoff", `agent:${session.agentId}`];
}

function computeDurationMinutes(session: Session): number {
  if (!session.closedAt) return 0;
  const opened = Date.parse(session.openedAt);
  const closed = Date.parse(session.closedAt);
  if (!Number.isFinite(opened) || !Number.isFinite(closed)) return 0;
  return Math.max(0, Math.round((closed - opened) / 60_000));
}

// ─── Body renderer ───────────────────────────────────────────────────────────

/**
 * Render the handoff article markdown body from a closed Session + facts.json
 * + validated LLM summary. Sections with no content (empty arrays) are
 * skipped — sparse handoffs stay compact instead of showing scaffold.
 *
 * The output is the BODY of a knowledge article (no frontmatter) — the caller
 * persists it through `KnowledgeService.create({ category: "handoff", ... })`
 * which writes the frontmatter.
 */
export function renderHandoffArticle(
  session: Session,
  facts: SessionFacts,
  summary: LLMSummary,
): string {
  const sections: string[] = [];

  sections.push(renderHeader(session, facts));
  sections.push(renderTldr(summary));
  sections.push(renderWhatHappened(summary));
  sections.push(renderWhatsNext(summary));
  sections.push(renderHypergraph(facts));
  sections.push(renderFacts(session));

  return sections.filter((s) => s.length > 0).join("\n\n") + "\n";
}

/**
 * ADR-019 agent-direct render path.
 *
 * The executing agent (Claude, Codex, etc.) writes the substantive
 * content directly — TL;DR + What happened + What's next + Decisions
 * + Blockers + Surprises + Deferred — and the CLI assembles the final
 * article by wrapping with the deterministic header and appending the
 * Hypergraph + Facts pointer sections derived from `facts.json`.
 *
 * Why split this way:
 *   - The HEADER is deterministic metadata (session id, agent id,
 *     duration, quality, intent, parent pointer) the agent shouldn't
 *     have to author.
 *   - The HYPERGRAPH + FACTS sections are derived from Stage A
 *     (`facts.json`) — agent-supplied content here would only
 *     duplicate or contradict the deterministic extract.
 *   - Everything between is content only the agent — with full
 *     session context — can produce well.
 *
 * The agent's body is trimmed and inserted verbatim. The agent is
 * responsible for the structure (markdown headings, list shape); the
 * coverage validator runs as an advisory pass against the assembled
 * article body, identical to the LLM path.
 */
export function renderAgentWrittenHandoff(
  session: Session,
  facts: SessionFacts,
  agentBody: string,
): string {
  const sections: string[] = [];

  sections.push(renderHeader(session, facts));

  const trimmed = agentBody.trim();
  if (trimmed.length > 0) {
    sections.push(trimmed);
  }

  sections.push(renderHypergraph(facts));
  sections.push(renderFacts(session));

  return sections.filter((s) => s.length > 0).join("\n\n") + "\n";
}

function renderHeader(session: Session, _facts: SessionFacts): string {
  const duration = computeDurationMinutes(session);
  const lines: string[] = [
    `> **Session** \`${session.id}\` · agent \`${session.agentId}\` · ${duration} min`,
  ];
  const qual = session.quality;
  if (qual.score !== null || qual.model !== null || qual.degraded) {
    const scorePart = qual.score !== null ? `Quality ${qual.score}/5` : "Quality (no eval)";
    const modelPart = qual.model !== null ? ` (${qual.model})` : "";
    const degradedPart = qual.degraded ? " · degraded (Ollama unavailable)" : "";
    lines.push(`> ${scorePart}${modelPart}${degradedPart}`);
  }
  if (session.parentSessionId) {
    lines.push(`> Previous: [${session.parentSessionId}](handoff-${session.parentSessionId}.md)`);
  }
  if (session.intent) {
    lines.push(`> Intent: ${session.intent}`);
  }
  return lines.join("\n");
}

function renderTldr(summary: LLMSummary): string {
  return ["## TL;DR", "", summary.tldr.trim()].join("\n");
}

function renderWhatHappened(summary: LLMSummary): string {
  const lines: string[] = ["## What happened", "", summary.summary.trim()];

  if (summary.decisions.length > 0) {
    lines.push("", "### Decisions");
    for (const d of summary.decisions) {
      const ev = d.evidence.length > 0 ? ` — evidence: [${d.evidence.join(", ")}]` : "";
      lines.push(`- ${d.text}${ev}`);
    }
  }

  // Always emit Blockers heading even when empty. Silence is ambiguous: the
  // next agent can't distinguish "nothing to flag" from "you forgot to check".
  // An explicit "(none identified)" tells them the previous agent looked.
  lines.push("", "### Blockers");
  if (summary.blockers.length > 0) {
    for (const b of summary.blockers) {
      const ev = b.evidence.length > 0 ? ` — evidence: [${b.evidence.join(", ")}]` : "";
      lines.push(`- ${b.text}${ev}`);
    }
  } else {
    lines.push("_(none identified)_");
  }

  if (summary.surprises.length > 0) {
    lines.push("", "### Surprises");
    for (const s of summary.surprises) {
      lines.push(`- ${s}`);
    }
  }

  if (summary.deferred.length > 0) {
    lines.push("", "### Deferred");
    for (const d of summary.deferred) {
      lines.push(`- ${d}`);
    }
  }

  return lines.join("\n");
}

function renderWhatsNext(summary: LLMSummary): string {
  if (
    summary.nextSteps.length === 0 &&
    summary.openQuestions.length === 0 &&
    summary.suggestedAgent === null
  ) {
    return "## What's next\n\n(no concrete next steps — review the Hypergraph below for context.)";
  }

  const lines: string[] = ["## What's next"];

  if (summary.nextSteps.length > 0) {
    const [first, ...rest] = summary.nextSteps;
    if (first) {
      lines.push("", "### First action");
      lines.push("", `**${first.action}**`);
      if (first.evidence.length > 0) {
        lines.push(`- evidence: [${first.evidence.join(", ")}]`);
      }
      if (first.why.length > 0) {
        lines.push(`- why: ${first.why}`);
      }
      if (summary.suggestedAgent) {
        lines.push(`- suggested agent: ${summary.suggestedAgent}`);
      }
    }
    if (rest.length > 0) {
      lines.push("", "### Next steps");
      for (const step of rest) {
        const ev = step.evidence.length > 0 ? ` — evidence: [${step.evidence.join(", ")}]` : "";
        const why = step.why.length > 0 ? ` — why: ${step.why}` : "";
        lines.push(`- ${step.action}${ev}${why}`);
      }
    }
  } else if (summary.suggestedAgent) {
    // No nextSteps but suggested agent was set — surface it as a standalone hint.
    lines.push("", `Suggested next agent: ${summary.suggestedAgent}`);
  }

  if (summary.openQuestions.length > 0) {
    lines.push("", "### Open questions");
    for (const q of summary.openQuestions) {
      lines.push(`- ${q}`);
    }
  }

  return lines.join("\n");
}

function renderHypergraph(facts: SessionFacts): string {
  const lines: string[] = ["## Hypergraph"];

  if (facts.workTouched.length > 0) {
    lines.push("", `**Work touched** (${facts.workTouched.length}):`);
    for (const w of facts.workTouched) {
      const phase = w.phaseAtOpen === w.phaseAtClose
        ? `phase: ${w.phaseAtClose}`
        : `phase: ${w.phaseAtOpen} → ${w.phaseAtClose}`;
      lines.push(`- [${w.id}](../work-articles/${w.id}.md) — ${w.title} — ${phase} (${w.role})`);
    }
  }

  if (facts.knowledgeTouched.length > 0) {
    lines.push("", `**Knowledge created/updated** (${facts.knowledgeTouched.length}):`);
    for (const k of facts.knowledgeTouched) {
      lines.push(`- [${k.slug}](${k.slug}.md) — ${k.title} (${k.op})`);
    }
  }

  if (facts.codeTouched.length > 0) {
    const top = facts.codeTouched.slice(0, 10);
    lines.push("", `**Code touched** (top ${top.length} of ${facts.codeTouched.length}):`);
    for (const c of top) {
      const owners = c.owners && c.owners.length > 0 ? `, owners: [${c.owners.join(", ")}]` : "";
      const impact = c.impactScore !== undefined ? `, impact: ${c.impactScore}` : "";
      lines.push(`- \`${c.path}\` (+${c.linesAdded}/-${c.linesRemoved}${impact}${owners})`);
    }
  }

  if (facts.commits.length > 0) {
    const top = facts.commits.slice(0, 10);
    lines.push("", `**Commits** (${top.length} of ${facts.commits.length}):`);
    for (const c of top) {
      lines.push(`- \`${c.sha.slice(0, 8)}\` ${c.subject}`);
    }
  }

  lines.push("", `Events in window: ${facts.events.length}`);

  return lines.join("\n");
}

function renderFacts(session: Session): string {
  if (!session.factsPath) return "";
  const fileName = path.basename(session.factsPath);
  return ["## Facts (raw, for downstream LLM)", "", `See [\`${fileName}\`](../sessions/${fileName}).`].join("\n");
}

// ─── Brief / depth slicing ───────────────────────────────────────────────────

export interface ParsedHandoffSections {
  /** The pre-`## ` block at the top of the article (`> Session …` lines). */
  readonly preamble: string;
  /**
   * Section name (heading text without `## `) → section body (everything until
   * the next `^## ` heading, trimmed of trailing whitespace).
   */
  readonly sections: ReadonlyMap<string, string>;
}

/**
 * Parse a rendered handoff article body into its preamble + level-2 sections.
 * Subsections (`### …`) stay inside their parent section. The parser tolerates
 * articles without a preamble and articles missing some standard sections —
 * callers must handle a missing `TL;DR` etc. by themselves.
 */
export function parseHandoffSections(body: string): ParsedHandoffSections {
  const chunks = body.split(/^## /m);
  const preamble = (chunks[0] ?? "").trim();
  const sections = new Map<string, string>();
  for (const chunk of chunks.slice(1)) {
    const newlineIdx = chunk.indexOf("\n");
    if (newlineIdx === -1) {
      // section heading with no body
      sections.set(chunk.trim(), "");
      continue;
    }
    const title = chunk.slice(0, newlineIdx).trim();
    const sectionBody = chunk.slice(newlineIdx + 1).trimEnd();
    sections.set(title, sectionBody);
  }
  return { preamble, sections };
}

/**
 * Render the "standard" depth: preamble + TL;DR + What's next + a one-line
 * Hypergraph summary. Drops "What happened" (the deep narrative) and the
 * Facts pointer. Sections that are not present in the input are silently
 * skipped, so degraded articles still produce something readable.
 */
export function renderBriefStandard(parsed: ParsedHandoffSections): string {
  const blocks: string[] = [];
  if (parsed.preamble.length > 0) blocks.push(parsed.preamble);
  for (const name of ["TL;DR", "What's next", "Hypergraph"]) {
    const sectionBody = parsed.sections.get(name);
    if (sectionBody !== undefined && sectionBody.length > 0) {
      blocks.push(`## ${name}\n\n${sectionBody}`);
    }
  }
  return blocks.join("\n\n") + "\n";
}

/**
 * Render the "teaser" depth: a compact, ~200-token slice. Just the session
 * header + TL;DR — no Hypergraph, no What's next list. If the article had no
 * TL;DR (degraded), the preamble alone is returned with a note.
 */
export function renderBriefTeaser(parsed: ParsedHandoffSections): string {
  const tldr = parsed.sections.get("TL;DR");
  const blocks: string[] = [];
  if (parsed.preamble.length > 0) blocks.push(parsed.preamble);
  if (tldr !== undefined && tldr.length > 0) {
    blocks.push(`## TL;DR\n\n${tldr}`);
  } else {
    blocks.push("## TL;DR\n\n_No TL;DR available (handoff may be degraded)._");
  }
  return blocks.join("\n\n") + "\n";
}

/**
 * Body used when a session was closed but its handoff article never got
 * attached (orphan: async worker failed or has not finished yet). Gives the
 * brief reader the lifecycle facts they would otherwise have gotten from the
 * handoff article preamble + a hint at how to recover.
 */
export function renderOrphanBrief(session: Session): string {
  const duration = computeDurationMinutes(session);
  const lines: string[] = [
    `> **Session** \`${session.id}\` · agent \`${session.agentId}\` · ${duration} min`,
    `> Status: \`${session.status}\` · handoff: _not yet generated_`,
  ];
  if (session.intent) lines.push(`> Intent: ${session.intent}`);
  lines.push(
    "",
    "## TL;DR",
    "",
    "_This session closed but its handoff article was never attached._",
    "_Recover with_ `monsthera session _generate-handoff " + session.id + "`.",
  );
  return lines.join("\n") + "\n";
}
