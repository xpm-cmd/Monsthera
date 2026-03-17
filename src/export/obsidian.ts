import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface ObsidianExportOptions {
  vaultPath: string;
  repoDb: DB;
  globalDb: DB | null;
}

interface KnowledgeEntry {
  key: string;
  type: string;
  scope: string;
  title: string;
  content: string;
  tagsJson: string | null;
  status: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function exportToObsidian(opts: ObsidianExportOptions): { exported: number; path: string } {
  const baseDir = join(opts.vaultPath, "Agora");

  const entries: KnowledgeEntry[] = [];

  const repoEntries = queries.queryKnowledge(opts.repoDb, {});
  entries.push(...repoEntries.map((e) => ({ ...e, scope: "repo" })));

  if (opts.globalDb) {
    const globalEntries = queries.queryKnowledge(opts.globalDb, {});
    entries.push(...globalEntries.map((e) => ({ ...e, scope: "global" })));
  }

  for (const entry of entries) {
    const safeType = entry.type.replace(/[./\\]/g, "_");
    const typeDir = join(baseDir, safeType);
    mkdirSync(typeDir, { recursive: true });

    const slug = slugify(entry.title);
    const filename = join(typeDir, `${slug}.md`);
    writeFileSync(filename, renderMarkdown(entry), "utf-8");
  }

  return { exported: entries.length, path: baseDir };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "untitled";
}

function renderMarkdown(entry: KnowledgeEntry): string {
  const tags: string[] = entry.tagsJson ? JSON.parse(entry.tagsJson) : [];

  const lines = [
    "---",
    `type: ${entry.type}`,
    `scope: ${entry.scope}`,
    `key: ${JSON.stringify(entry.key)}`,
    `status: ${entry.status ?? "active"}`,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
  ];

  if (entry.agentId) {
    lines.push(`agentId: ${JSON.stringify(entry.agentId)}`);
  }

  lines.push(
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
    "---",
  );

  return `${lines.join("\n")}\n\n# ${entry.title}\n\n${entry.content}\n`;
}
