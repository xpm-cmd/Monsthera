import { loadConfig, defaultConfig } from "../core/config.js";
import { createContainer } from "../core/container.js";
import { VERSION } from "../core/constants.js";
import { startServer } from "../server.js";

// ─── Command handlers ─────────────────────────────────────────────────────────

async function handleServe(args: string[]): Promise<void> {
  const repoPath = parseRepoPath(args) ?? process.cwd();
  const configResult = loadConfig(repoPath);

  let config;
  if (configResult.ok) {
    config = configResult.value;
  } else {
    // Fall back to default config if no config file found
    config = defaultConfig(repoPath);
  }

  const container = await createContainer(config);
  await startServer(container);
}

async function handleStatus(args: string[]): Promise<void> {
  const repoPath = parseRepoPath(args) ?? process.cwd();
  const configResult = loadConfig(repoPath);

  let config;
  if (configResult.ok) {
    config = configResult.value;
  } else {
    config = defaultConfig(repoPath);
  }

  const container = await createContainer(config);
  try {
    const status = container.status.getStatus();
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  } finally {
    await container.dispose();
  }
}

function handleVersion(): void {
  process.stdout.write(VERSION + "\n");
}

function handleHelp(): void {
  process.stdout.write(
    [
      "monsthera — Knowledge-native development platform for AI coding agents",
      "",
      "USAGE",
      "  monsthera <command> [options]",
      "",
      "COMMANDS",
      "  serve       Start the MCP server (stdio transport)",
      "  status      Print system status as JSON and exit",
      "",
      "OPTIONS",
      "  --version, -v   Print version and exit",
      "  --help, -h      Show this help message",
      "",
      "EXAMPLES",
      "  monsthera serve",
      "  monsthera status",
      "  monsthera --version",
      "",
    ].join("\n"),
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseRepoPath(args: string[]): string | undefined {
  const repoFlag = args.findIndex((a) => a === "--repo" || a === "-r");
  if (repoFlag !== -1 && args[repoFlag + 1]) {
    return args[repoFlag + 1];
  }
  return undefined;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function main(args: string[]): Promise<void> {
  const command = args[0];

  switch (command) {
    case "serve":
      await handleServe(args.slice(1));
      break;
    case "status":
      await handleStatus(args.slice(1));
      break;
    case "--version":
    case "-v":
      handleVersion();
      break;
    case "--help":
    case "-h":
    case undefined:
      handleHelp();
      break;
    default:
      // eslint-disable-next-line no-console
      console.error(`Unknown command: ${command}`);
      // eslint-disable-next-line no-console
      console.error('Run "monsthera --help" for usage.');
      process.exit(1);
  }
}
