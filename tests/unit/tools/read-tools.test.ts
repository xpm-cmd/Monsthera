import { beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "../../../src/tools/read-tools.js";

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();

  tool(name: string, _description: string, _schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
  }
}

describe("read tool discovery", () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerReadTools(server as unknown as McpServer, async () => ({
      repoId: 1,
      repoPath: "/test",
      config: {
        coordinationTopology: "hub-spoke",
        debugLogging: false,
      },
      searchRouter: {
        getSemanticReranker: () => null,
      },
    } as any));
  });

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("lists the full registered tool surface in capabilities", async () => {
    const result = await handler("capabilities")({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload.tools).toEqual(expect.arrayContaining([
      "send_coordination",
      "poll_coordination",
      "list_patches",
      "list_notes",
      "end_session",
    ]));
  });

  it("describes required actor fields for protected knowledge and coordination tools", async () => {
    const storeKnowledge = await handler("schema")({ toolName: "store_knowledge" });
    const pollCoordination = await handler("schema")({ toolName: "poll_coordination" });
    const endSession = await handler("schema")({ toolName: "end_session" });

    expect(JSON.parse(storeKnowledge.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(pollCoordination.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
    expect(JSON.parse(endSession.content[0].text).inputSchema).toMatchObject({
      agentId: "string (required)",
      sessionId: "string (required)",
    });
  });

  it("keeps note schemas aligned with the supported note types", async () => {
    const proposeNote = await handler("schema")({ toolName: "propose_note" });
    const listNotes = await handler("schema")({ toolName: "list_notes" });

    expect(JSON.parse(proposeNote.content[0].text).inputSchema.type).toContain("runbook");
    expect(JSON.parse(proposeNote.content[0].text).inputSchema.type).toContain("file_summary");
    expect(JSON.parse(listNotes.content[0].text).inputSchema.type).not.toContain("rationale");
  });
});
