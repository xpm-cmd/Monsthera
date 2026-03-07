import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION, SUPPORTED_LANGUAGES } from "./core/constants.js";
import type { AgoraConfig } from "./core/config.js";

export function createAgoraServer(config: AgoraConfig) {
  const server = new McpServer({
    name: "agora",
    version: VERSION,
  });

  server.tool("status", "Get Agora index status and connected agents", {}, async () => {
    const result = {
      version: VERSION,
      repoPath: config.repoPath,
      coordinationTopology: config.coordinationTopology,
      indexedCommit: null as string | null,
      indexStale: false,
      connectedAgents: 0,
      searchBackend: config.zoektEnabled ? "zoekt" : "fts5",
      debugLogging: config.debugLogging,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });

  server.tool("capabilities", "List Agora capabilities, tools, and supported features", {}, async () => {
    const result = {
      version: VERSION,
      tools: [
        "status",
        "capabilities",
        "schema",
        "get_code_pack",
        "get_change_pack",
        "get_issue_pack",
        "propose_patch",
        "propose_note",
        "register_agent",
        "agent_status",
        "broadcast",
        "claim_files",
        "request_reindex",
      ],
      languages: [...SUPPORTED_LANGUAGES],
      trustTiers: ["A", "B"],
      roles: ["developer", "reviewer", "observer", "admin"],
      coordinationTopologies: ["hub-spoke", "hybrid", "mesh"],
      outputFormats: ["json", "ndjson"],
      evidenceBundleStages: ["A", "B"],
      maxCandidates: 5,
      maxExpanded: 3,
      maxCodeSpanLines: 200,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
}
