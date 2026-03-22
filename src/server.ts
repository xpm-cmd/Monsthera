import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./core/constants.js";
import type { MonstheraConfig } from "./core/config.js";
import type { MonstheraContext } from "./core/context.js";
import { InsightStream } from "./core/insight-stream.js";
import { createMonstheraContextLoader } from "./core/context-loader.js";
import { registerReadTools } from "./tools/read-tools.js";
import { registerIndexTools } from "./tools/index-tools.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerPatchTools } from "./tools/patch-tools.js";
import { registerNoteTools } from "./tools/note-tools.js";
import { registerCoordinationTools } from "./tools/coordination-tools.js";
import { registerKnowledgeTools } from "./tools/knowledge-tools.js";
import { registerTicketTools } from "./tools/ticket-tools.js";
import { registerProtectionTools } from "./tools/protection-tools.js";
import { registerWorkflowTools } from "./tools/workflow-tools.js";
import { registerSimulationTools } from "./tools/simulation-tools.js";
import { registerJobTools } from "./tools/job-tools.js";
import { registerWorkGroupTools } from "./tools/work-group-tools.js";
import { registerDecomposeTools } from "./tools/decompose-tools.js";
import { registerWaveTools } from "./tools/wave-tools.js";
import { registerSpawnTools } from "./tools/spawn-tools.js";
import { registerGovernanceTools } from "./tools/governance-tools.js";
import { installToolRuntimeInstrumentation } from "./tools/runtime-instrumentation.js";

export function createMonstheraServer(
  config: MonstheraConfig,
  opts: {
    insight?: InsightStream;
    getContext?: () => Promise<MonstheraContext>;
  } = {},
) {
  const server = new McpServer({
    name: "monsthera",
    version: VERSION,
  });

  const insight = opts.insight ?? new InsightStream(config.verbosity);
  const getContext = opts.getContext ?? createMonstheraContextLoader(config, insight);

  installToolRuntimeInstrumentation(server, getContext);

  // Register tool groups
  registerReadTools(server, getContext);
  registerIndexTools(server, getContext);
  registerAgentTools(server, getContext);
  registerPatchTools(server, getContext);
  registerNoteTools(server, getContext);
  registerCoordinationTools(server, getContext);
  registerKnowledgeTools(server, getContext);
  registerTicketTools(server, getContext);
  registerProtectionTools(server, getContext);
  registerWorkflowTools(server, getContext);
  registerSimulationTools(server, getContext);
  registerJobTools(server, getContext);
  registerWorkGroupTools(server, getContext);
  registerDecomposeTools(server, getContext);
  registerWaveTools(server, getContext);
  registerSpawnTools(server, getContext);
  registerGovernanceTools(server, getContext);

  return server;
}
