import { describe, it, expect } from "vitest";
import { CAPABILITY_TOOL_NAMES } from "../../../src/tools/tool-manifest.js";

describe("tool-manifest", () => {
  it("exports the expected number of capability tools", () => {
    expect(CAPABILITY_TOOL_NAMES.length).toBe(71);
  });

  it("contains all core MCP tool names", () => {
    const names = new Set(CAPABILITY_TOOL_NAMES);

    // Status & discovery
    expect(names.has("status")).toBe(true);
    expect(names.has("capabilities")).toBe(true);
    expect(names.has("schema")).toBe(true);

    // Code retrieval
    expect(names.has("get_code_pack")).toBe(true);
    expect(names.has("get_change_pack")).toBe(true);
    expect(names.has("get_issue_pack")).toBe(true);
    expect(names.has("search_remote_instances")).toBe(true);
    expect(names.has("run_workflow")).toBe(true);

    // Agent management
    expect(names.has("register_agent")).toBe(true);
    expect(names.has("agent_status")).toBe(true);
    expect(names.has("end_session")).toBe(true);

    // Knowledge
    expect(names.has("store_knowledge")).toBe(true);
    expect(names.has("search_knowledge")).toBe(true);
    expect(names.has("query_knowledge")).toBe(true);
    expect(names.has("archive_knowledge")).toBe(true);
    expect(names.has("delete_knowledge")).toBe(true);

    // Tickets
    expect(names.has("create_ticket")).toBe(true);
    expect(names.has("update_ticket_status")).toBe(true);
    expect(names.has("get_ticket")).toBe(true);
    expect(names.has("list_tickets")).toBe(true);
    expect(names.has("search_tickets")).toBe(true);
    expect(names.has("comment_ticket")).toBe(true);
    expect(names.has("assign_council")).toBe(true);
    expect(names.has("submit_verdict")).toBe(true);
    expect(names.has("check_consensus")).toBe(true);
    expect(names.has("link_tickets")).toBe(true);
    expect(names.has("unlink_tickets")).toBe(true);
    expect(names.has("list_protected_artifacts")).toBe(true);

    // Coordination
    expect(names.has("send_coordination")).toBe(true);
    expect(names.has("poll_coordination")).toBe(true);
    expect(names.has("broadcast")).toBe(true);

    // Other
    expect(names.has("propose_patch")).toBe(true);
    expect(names.has("propose_note")).toBe(true);
    expect(names.has("claim_files")).toBe(true);
    expect(names.has("analyze_complexity")).toBe(true);
    expect(names.has("analyze_test_coverage")).toBe(true);
    expect(names.has("suggest_actions")).toBe(true);
    expect(names.has("suggest_next_work")).toBe(true);
    expect(names.has("lookup_dependencies")).toBe(true);
    expect(names.has("trace_dependencies")).toBe(true);
    expect(names.has("export_audit")).toBe(true);
    expect(names.has("add_protected_artifact")).toBe(true);
    expect(names.has("remove_protected_artifact")).toBe(true);

    // Simulation
    expect(names.has("run_simulation")).toBe(true);
    expect(names.has("run_optimization")).toBe(true);
  });

  it("contains no duplicate tool names", () => {
    const unique = new Set(CAPABILITY_TOOL_NAMES);
    expect(unique.size).toBe(CAPABILITY_TOOL_NAMES.length);
  });
});
