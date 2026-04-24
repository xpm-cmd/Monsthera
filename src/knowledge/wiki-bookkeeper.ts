import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "../core/logger.js";
import type { KnowledgeArticle } from "./repository.js";
import type { WorkArticle } from "../work/repository.js";

/**
 * Karpathy-style wiki bookkeeper: maintains index.md (navigable catalog)
 * and log.md (append-only mutation log) alongside the markdown articles.
 *
 * Injected into KnowledgeService and WorkService to auto-update on every
 * create/update/delete. The index groups articles by category with one-line
 * summaries. The log records every mutation with timestamp and action.
 */
export class WikiBookkeeper {
  private readonly indexPath: string;
  private readonly logPath: string;

  constructor(
    markdownRoot: string,
    private readonly logger: Logger,
  ) {
    this.indexPath = path.join(markdownRoot, "index.md");
    this.logPath = path.join(markdownRoot, "log.md");
  }

  // ─── Read access (for MCP tools) ────────────────────────────────────────

  /** Read index.md content, or null if it does not exist yet. */
  async readIndex(): Promise<{ content: string; path: string } | null> {
    try {
      const content = await fs.readFile(this.indexPath, "utf-8");
      return { content, path: this.indexPath };
    } catch {
      return null;
    }
  }

  /**
   * Read log.md content, or null if it does not exist yet. When `tail` is
   * provided, only the last N non-empty lines are returned, preserving the
   * file header so the response is still self-describing.
   */
  async readLog(options?: { tail?: number }): Promise<{ content: string; path: string; totalLines: number } | null> {
    try {
      const content = await fs.readFile(this.logPath, "utf-8");
      const allLines = content.split("\n");
      if (options?.tail === undefined) {
        return { content, path: this.logPath, totalLines: allLines.length };
      }
      // Preserve the header (non-entry lines at top) plus the last `tail`
      // entry lines. Entry lines start with "- **[" per appendLog().
      const headerLines: string[] = [];
      const entryLines: string[] = [];
      for (const line of allLines) {
        if (line.startsWith("- **[")) {
          entryLines.push(line);
        } else if (entryLines.length === 0) {
          headerLines.push(line);
        }
      }
      const tailedEntries = entryLines.slice(-options.tail);
      const tailedContent = [...headerLines, ...tailedEntries].join("\n");
      return { content: tailedContent, path: this.logPath, totalLines: allLines.length };
    } catch {
      return null;
    }
  }

  // ─── Log (append-only) ──────────────────────────────────────────────────

  async appendLog(
    action: "create" | "update" | "delete" | "advance" | "reindex" | "archive" | "rename",
    type: "knowledge" | "work",
    title: string,
    id?: string,
  ): Promise<void> {
    try {
      const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
      const idSuffix = id ? ` (${id})` : "";
      const entry = `- **[${ts}]** ${action} ${type} | ${title}${idSuffix}\n`;

      // Ensure file exists with header
      try {
        await fs.access(this.logPath);
      } catch {
        await fs.writeFile(
          this.logPath,
          "# Monsthera Log\n\nAppend-only record of knowledge and work mutations.\n\n",
          "utf-8",
        );
      }

      await fs.appendFile(this.logPath, entry, "utf-8");
    } catch (error) {
      this.logger.warn("Failed to append to log.md", { error: String(error) });
    }
  }

  // ─── Index (full rebuild) ───────────────────────────────────────────────

  async rebuildIndex(
    knowledgeArticles: readonly KnowledgeArticle[],
    workArticles: readonly WorkArticle[],
  ): Promise<void> {
    try {
      const lines: string[] = [
        "# Monsthera Index",
        "",
        `> Auto-generated catalog of ${knowledgeArticles.length} knowledge articles and ${workArticles.length} work articles.`,
        `> Last updated: ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
        "",
      ];

      // ── Knowledge articles by category ─────────────────────────────────
      lines.push("## Knowledge");
      lines.push("");

      const knowledgeByCategory = new Map<string, KnowledgeArticle[]>();
      for (const article of knowledgeArticles) {
        const cat = article.category || "uncategorized";
        let bucket = knowledgeByCategory.get(cat);
        if (!bucket) {
          bucket = [];
          knowledgeByCategory.set(cat, bucket);
        }
        bucket.push(article);
      }

      const sortedCategories = [...knowledgeByCategory.keys()].sort();
      for (const category of sortedCategories) {
        const articles = knowledgeByCategory.get(category)!;
        articles.sort((a, b) => a.title.localeCompare(b.title));

        lines.push(`### ${category}`);
        lines.push("");
        if (category === "policy") {
          renderPolicySection(lines, articles);
        } else {
          for (const article of articles) {
            const snippet = article.content.slice(0, 80).replace(/\n/g, " ").trim();
            lines.push(`- [${article.title}](notes/${article.slug}.md) — ${snippet}`);
          }
        }
        lines.push("");
      }

      // ── Work articles by phase ─────────────────────────────────────────
      lines.push("## Work");
      lines.push("");

      const workByPhase = new Map<string, WorkArticle[]>();
      for (const article of workArticles) {
        const phase = article.phase || "planning";
        let bucket = workByPhase.get(phase);
        if (!bucket) {
          bucket = [];
          workByPhase.set(phase, bucket);
        }
        bucket.push(article);
      }

      const phaseOrder = ["planning", "enrichment", "implementation", "review", "done", "cancelled"];
      const sortedPhases = [...workByPhase.keys()].sort(
        (a, b) => (phaseOrder.indexOf(a) === -1 ? 99 : phaseOrder.indexOf(a)) -
                  (phaseOrder.indexOf(b) === -1 ? 99 : phaseOrder.indexOf(b)),
      );

      for (const phase of sortedPhases) {
        const articles = workByPhase.get(phase)!;
        articles.sort((a, b) => a.title.localeCompare(b.title));

        lines.push(`### ${phase} (${articles.length})`);
        lines.push("");
        for (const article of articles) {
          const priority = article.priority ? ` [${article.priority}]` : "";
          const snippet = (article.content || "").slice(0, 60).replace(/\n/g, " ").trim();
          lines.push(`- [${article.title}](work-articles/${article.id}.md)${priority} — ${snippet}`);
        }
        lines.push("");
      }

      await fs.writeFile(this.indexPath, lines.join("\n"), "utf-8");
    } catch (error) {
      this.logger.warn("Failed to rebuild index.md", { error: String(error) });
    }
  }
}

/**
 * Render the "policy" knowledge category as a table so auditors can scan the
 * active control plane at a glance. Reads policy_* fields straight from
 * `extraFrontmatter` — deliberately decoupled from `PolicyLoader` because the
 * bookkeeper is a display layer, not a validator. Missing fields show as `—`.
 */
function renderPolicySection(lines: string[], articles: readonly KnowledgeArticle[]): void {
  lines.push("| Policy | Templates | Transition | Requires Roles | Requires Articles |");
  lines.push("|--------|-----------|------------|----------------|-------------------|");
  for (const article of articles) {
    const fm = article.extraFrontmatter ?? {};
    const templates = formatList(fm.policy_applies_templates);
    const transition = typeof fm.policy_phase_transition === "string"
      ? fm.policy_phase_transition.replace("->", " → ")
      : "—";
    const roles = formatList(fm.policy_requires_roles);
    const refs = formatList(fm.policy_requires_articles);
    lines.push(
      `| [${article.title}](notes/${article.slug}.md) | ${templates} | ${transition} | ${roles} | ${refs} |`,
    );
  }
}

function formatList(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "—";
  return value.map((v) => String(v)).join(", ");
}
