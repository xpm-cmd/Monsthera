import type { CapabilityToolName } from "../tools/tool-manifest.js";

export type ToolAccessMode = "public" | "session" | "role";

export interface ToolAccessPolicyEntry {
  mode: ToolAccessMode;
}

export const TOOL_ACCESS_POLICY: Record<CapabilityToolName, ToolAccessPolicyEntry> = {
  status: { mode: "public" },
  capabilities: { mode: "public" },
  schema: { mode: "public" },
  get_code_pack: { mode: "public" },
  get_change_pack: { mode: "public" },
  get_issue_pack: { mode: "public" },
  propose_patch: { mode: "role" },
  propose_note: { mode: "role" },
  register_agent: { mode: "public" },
  agent_status: { mode: "public" },
  broadcast: { mode: "role" },
  send_coordination: { mode: "role" },
  poll_coordination: { mode: "session" },
  claim_files: { mode: "role" },
  end_session: { mode: "session" },
  request_reindex: { mode: "role" },
  list_patches: { mode: "role" },
  list_notes: { mode: "role" },
  store_knowledge: { mode: "role" },
  search_knowledge: { mode: "public" },
  query_knowledge: { mode: "public" },
  archive_knowledge: { mode: "role" },
  delete_knowledge: { mode: "role" },
  create_ticket: { mode: "role" },
  assign_ticket: { mode: "role" },
  update_ticket_status: { mode: "role" },
  update_ticket: { mode: "role" },
  list_tickets: { mode: "role" },
  get_ticket: { mode: "role" },
  comment_ticket: { mode: "role" },
};
