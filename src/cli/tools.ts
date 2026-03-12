import { readFile } from "node:fs/promises";
import type { AgoraConfig } from "../core/config.js";
import type { AgoraContext } from "../core/context.js";
import { createAgoraContextLoader } from "../core/context-loader.js";
import type { InsightStream } from "../core/insight-stream.js";
import { createAgoraServer } from "../server.js";
import { getToolRunner, type ToolRunner } from "../tools/tool-runner.js";

export interface ToolCliDeps {
  createServer?: typeof createAgoraServer;
  getRunner?: (server: ReturnType<typeof createAgoraServer>) => ToolRunner;
  readFile?: typeof readFile;
}

export async function cmdTool(
  config: AgoraConfig,
  insight: InsightStream,
  args: string[],
  deps: ToolCliDeps = {},
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || args.includes("--help") || args.includes("-h")) {
    printToolHelp();
    return;
  }

  let context: AgoraContext | null = null;
  const baseGetContext = createAgoraContextLoader(config, insight);
  const getContext = async () => {
    context ??= await baseGetContext();
    return context;
  };

  const serverFactory = deps.createServer ?? createAgoraServer;
  const server = serverFactory(config, { insight, getContext });
  const runner = (deps.getRunner ?? getToolRunner)(server);
  const asJson = args.includes("--json");

  try {
    if (subcommand === "list") {
      printOutput(runner.listTools(), asJson, formatToolList);
      return;
    }

    if (subcommand === "inspect") {
      const toolName = args[1];
      if (!toolName) {
        throw new Error("Usage: agora tool inspect <tool-name> [--json]");
      }
      const result = await runner.callTool("schema", { toolName });
      renderToolCallResult(result, asJson, insight);
      return;
    }

    const input = await loadToolInput(args, deps.readFile ?? readFile);
    const result = await runner.callTool(subcommand, input);
    renderToolCallResult(result, asJson, insight);
  } catch (error) {
    insight.error(error instanceof Error ? error.message : String(error));
    printToolHelp();
    process.exitCode = 1;
  } finally {
    closeToolContext(context);
  }
}

function printOutput<T>(payload: T, asJson: boolean, formatter: (payload: T) => string): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(formatter(payload));
}

async function loadToolInput(
  args: string[],
  readFileImpl: typeof readFile,
): Promise<Record<string, unknown>> {
  const inline = getArg(args, "--input");
  const filePath = getArg(args, "--input-file");
  if (inline && filePath) {
    throw new Error("Use either --input or --input-file, not both");
  }

  if (!inline && !filePath) {
    return {};
  }

  const raw = inline ?? await readFileImpl(filePath!, "utf-8");
  const parsed = tryParseJsonObject(raw, filePath ? `input file ${filePath}` : "--input");
  return parsed;
}

function renderToolCallResult(
  result: Awaited<ReturnType<ToolRunner["callTool"]>>,
  asJson: boolean,
  insight: InsightStream,
): void {
  if (result.ok) {
    if (asJson) {
      console.log(JSON.stringify(result.result, null, 2));
      return;
    }
    console.log(formatToolResult(result.result));
    return;
  }

  process.exitCode = 1;
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  insight.error(formatToolFailure(result));
}

function formatToolList(tools: string[]): string {
  return tools.length > 0 ? tools.join("\n") : "No registered tools.";
}

function formatToolResult(result: unknown): string {
  const text = extractTextContent(result);
  if (text) return text;
  return JSON.stringify(result, null, 2);
}

function formatToolFailure(result: Exclude<Awaited<ReturnType<ToolRunner["callTool"]>>, { ok: true }>): string {
  const toolText = result.result ? extractTextContent(result.result) : null;
  return toolText ?? `${result.tool}: ${result.message}`;
}

function extractTextContent(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content)) return null;

  const text = content
    .map((entry) => (
      entry && typeof entry === "object" && typeof Reflect.get(entry, "text") === "string"
        ? String(Reflect.get(entry, "text"))
        : ""
    ))
    .filter(Boolean)
    .join("\n");

  return text || null;
}

function tryParseJsonObject(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${source}`);
  }
  return parsed as Record<string, unknown>;
}

function printToolHelp(): void {
  console.error("Tool commands:");
  console.error("  agora tool list [--json]");
  console.error("  agora tool inspect <tool-name> [--json]");
  console.error("  agora tool <tool-name> [--input <json>] [--input-file <path>] [--json]");
}

function closeToolContext(context: AgoraContext | null): void {
  context?.sqlite.close();
  context?.globalSqlite?.close();
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
