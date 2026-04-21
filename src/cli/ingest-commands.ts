/* eslint-disable no-console */
import { formatError, formatTable } from "./formatters.js";
import { parseCommaSeparated, parseFlag, withContainer } from "./arg-helpers.js";
import { printGroupHelp, printSubcommandHelp, wantsHelp } from "./help.js";

export async function handleIngest(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (subcommand === undefined || wantsHelp([subcommand])) {
    printGroupHelp({
      command: "monsthera ingest",
      summary: "Import local sources into knowledge.",
      subcommands: [
        { name: "local", summary: "Import a file or directory of Markdown/text into knowledge." },
      ],
    });
    return;
  }

  switch (subcommand) {
    case "local":
      await handleLocalIngest(subArgs);
      break;
    default:
      console.error(`Unknown ingest subcommand: ${subcommand}`);
      console.error('Run "monsthera ingest --help" for usage.');
      process.exit(1);
  }
}

async function handleLocalIngest(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera ingest local",
      summary: "Import a local file or directory of Markdown/text into knowledge.",
      usage: "--path <file-or-dir> [--category <c>] [--tags t1,t2] [--code-refs r1,r2] [--summary] [--no-recursive] [--no-replace]",
      flags: [
        { name: "--path <p>", required: true, description: "File or directory path. --source is accepted as an alias." },
        { name: "--category <c>", description: "Override category for imported articles." },
        { name: "--tags t1,t2", description: "Comma-separated tag list applied to every imported article." },
        { name: "--code-refs r1,r2", description: "Comma-separated code-reference overrides." },
        { name: "--summary", description: "Normalise content into a structured summary article." },
        { name: "--no-recursive", description: "Do not descend into subdirectories." },
        { name: "--no-replace", description: "Skip articles whose sourcePath already exists." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      examples: [
        "monsthera ingest local --path docs/adrs --summary",
      ],
    });
    return;
  }

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
