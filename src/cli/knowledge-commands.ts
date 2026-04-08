/* eslint-disable no-console */
import {
  formatArticle,
  formatTable,
  formatError,
} from "./formatters.js";
import {
  requireFlag,
  parseFlag,
  parsePositional,
  parseCommaSeparated,
  withContainer,
} from "./arg-helpers.js";

export async function handleKnowledge(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "create":
      await handleKnowledgeCreate(subArgs);
      break;
    case "get":
      await handleKnowledgeGet(subArgs);
      break;
    case "list":
      await handleKnowledgeList(subArgs);
      break;
    case "update":
      await handleKnowledgeUpdate(subArgs);
      break;
    case "delete":
      await handleKnowledgeDelete(subArgs);
      break;
    default:
      console.error(`Unknown knowledge subcommand: ${subcommand ?? "(none)"}`);
      console.error('Run "monsthera --help" for usage.');
      process.exit(1);
  }
}

async function handleKnowledgeCreate(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const title = requireFlag(args, "--title");
    const category = requireFlag(args, "--category");
    const content = requireFlag(args, "--content");
    const tags = parseCommaSeparated(args, "--tags");
    const codeRefs = parseCommaSeparated(args, "--code-refs");

    const input: Record<string, unknown> = { title, category, content };
    if (tags) input.tags = tags;
    if (codeRefs) input.codeRefs = codeRefs;

    const result = await container.knowledgeService.createArticle(input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatArticle(result.value) + "\n");
  });
}

async function handleKnowledgeGet(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const idOrSlug = parsePositional(args, 0);
    if (!idOrSlug) {
      console.error("Missing required argument: <id-or-slug>");
      process.exit(1);
    }

    // Try by ID first, then by slug
    const result = await container.knowledgeService.getArticle(idOrSlug);
    if (result.ok) {
      process.stdout.write(formatArticle(result.value) + "\n");
      return;
    }

    const slugResult = await container.knowledgeService.getArticleBySlug(idOrSlug);
    if (!slugResult.ok) {
      console.error(formatError(slugResult.error));
      process.exit(1);
    }
    process.stdout.write(formatArticle(slugResult.value) + "\n");
  });
}

async function handleKnowledgeList(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const category = parseFlag(args, "--category");
    const result = await container.knowledgeService.listArticles(category);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    if (result.value.length === 0) {
      process.stdout.write("No knowledge articles found.\n");
      return;
    }

    const headers = ["ID", "TITLE", "CATEGORY", "TAGS", "UPDATED"];
    const rows = result.value.map((a) => [
      a.id,
      a.title,
      a.category,
      a.tags.join(", "),
      a.updatedAt,
    ]);
    process.stdout.write(formatTable(headers, rows) + "\n");
  });
}

async function handleKnowledgeUpdate(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const input: Record<string, unknown> = {};
    const title = parseFlag(args, "--title");
    const category = parseFlag(args, "--category");
    const content = parseFlag(args, "--content");
    const tags = parseCommaSeparated(args, "--tags");

    if (title) input.title = title;
    if (category) input.category = category;
    if (content) input.content = content;
    if (tags) input.tags = tags;

    if (Object.keys(input).length === 0) {
      console.error("No update fields provided. Use --title, --category, --content, or --tags.");
      process.exit(1);
    }

    const result = await container.knowledgeService.updateArticle(id, input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatArticle(result.value) + "\n");
  });
}

async function handleKnowledgeDelete(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const result = await container.knowledgeService.deleteArticle(id);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(`Deleted knowledge article: ${id}\n`);
  });
}
