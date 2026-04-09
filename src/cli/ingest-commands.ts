/* eslint-disable no-console */
import { formatError, formatTable } from "./formatters.js";
import { parseCommaSeparated, parseFlag, withContainer } from "./arg-helpers.js";

export async function handleIngest(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "local":
      await handleLocalIngest(subArgs);
      break;
    default:
      console.error(`Unknown ingest subcommand: ${subcommand ?? "(none)"}`);
      console.error('Run "monsthera --help" for usage.');
      process.exit(1);
  }
}

async function handleLocalIngest(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const sourcePath = parseFlag(args, "--path") ?? parseFlag(args, "--source");
    if (!sourcePath) {
      console.error("Missing required flag: --path");
      process.exit(1);
    }

    const category = parseFlag(args, "--category");
    const tags = parseCommaSeparated(args, "--tags");
    const codeRefs = parseCommaSeparated(args, "--code-refs");
    const mode = args.includes("--summary") ? "summary" : "raw";
    const recursive = !args.includes("--no-recursive");
    const replaceExisting = !args.includes("--no-replace");

    const result = await container.ingestService.importLocal({
      sourcePath,
      category,
      tags,
      codeRefs,
      mode,
      recursive,
      replaceExisting,
    });

    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    process.stdout.write(
      [
        `Source:       ${result.value.sourcePath}`,
        `Mode:         ${result.value.mode}`,
        `Scanned:      ${result.value.scannedFileCount}`,
        `Imported:     ${result.value.importedCount}`,
        `Created:      ${result.value.createdCount}`,
        `Updated:      ${result.value.updatedCount}`,
        `Imported at:  ${result.value.importedAt}`,
        "",
      ].join("\n"),
    );

    if (result.value.items.length > 0) {
      process.stdout.write(formatTable(
        ["STATUS", "TITLE", "CATEGORY", "SLUG", "SOURCE"],
        result.value.items.map((item) => [
          item.status,
          item.title,
          item.category,
          item.slug,
          item.sourcePath,
        ]),
      ) + "\n");
    }
  });
}
