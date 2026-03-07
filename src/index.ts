import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgoraServer } from "./server.js";
import { resolveConfig } from "./core/config.js";
import { VERSION } from "./core/constants.js";

async function main() {
  const args = process.argv.slice(2);

  // Simple arg parsing for MVP
  const repoPath = getArg(args, "--repo-path") ?? process.cwd();
  const verbosity = (getArg(args, "--verbosity") ?? "normal") as "quiet" | "normal" | "verbose";
  const debugLogging = args.includes("--debug-logging");

  if (args.includes("--version") || args.includes("-v")) {
    console.error(`agora v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.error(`agora v${VERSION} — Multi-agent shared context server`);
    console.error("");
    console.error("Usage: agora [options]");
    console.error("");
    console.error("Options:");
    console.error("  --repo-path <path>   Repository path (default: cwd)");
    console.error("  --verbosity <level>  quiet | normal | verbose (default: normal)");
    console.error("  --debug-logging      Enable raw payload capture (24h TTL)");
    console.error("  --version, -v        Show version");
    console.error("  --help, -h           Show this help");
    process.exit(0);
  }

  const config = resolveConfig({
    repoPath,
    verbosity,
    debugLogging,
  });

  if (config.verbosity !== "quiet") {
    console.error(`[AGORA] v${VERSION} starting for ${config.repoPath}`);
    if (config.debugLogging) {
      console.error("[AGORA] \u26A0 Debug logging active \u2014 raw payloads captured (24h TTL)");
    }
  }

  const server = createAgoraServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main().catch((err) => {
  console.error("[AGORA] Fatal error:", err);
  process.exit(1);
});
