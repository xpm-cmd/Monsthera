export const CAPABILITY_TOOL_NAMES = [
  "status", "capabilities", "schema",
  "get_code_pack", "get_change_pack", "get_issue_pack",
  "propose_patch", "propose_note",
  "register_agent", "agent_status", "broadcast",
  "send_coordination", "poll_coordination",
  "claim_files", "end_session", "request_reindex",
  "list_patches", "list_notes",
  "store_knowledge", "search_knowledge", "query_knowledge", "archive_knowledge", "delete_knowledge",
  "create_ticket", "assign_ticket", "update_ticket_status", "update_ticket",
  "list_tickets", "search_tickets", "get_ticket", "comment_ticket",
  "link_tickets", "unlink_tickets",
  "lookup_dependencies",
] as const;

export type CapabilityToolName = (typeof CAPABILITY_TOOL_NAMES)[number];
