import { describe, expect, it, vi } from "vitest";
import type { MonstheraContext } from "../../../src/core/context.js";
import {
  getCrossInstanceCapabilityTool,
  runLocalCrossInstanceSearch,
  searchAcrossRemoteInstances,
} from "../../../src/federation/search.js";

describe("federation search", () => {
  it("maps search surfaces to the expected capability tools", () => {
    expect(getCrossInstanceCapabilityTool("code")).toBe("get_code_pack");
    expect(getCrossInstanceCapabilityTool("knowledge")).toBe("search_knowledge");
    expect(getCrossInstanceCapabilityTool("tickets")).toBe("search_tickets");
  });

  it("builds local code search responses with the local instance id", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        path: "src/remote.ts",
        score: 0.91234,
        snippet: "export const remote = true;",
        matchLines: [3, 4],
      },
    ]);

    const ctx = {
      config: {
        crossInstance: {
          enabled: true,
          instanceId: "monsthera-main",
          peers: [],
        },
      },
      repoId: 1,
      searchRouter: {
        search,
      },
    } as unknown as MonstheraContext;

    const result = await runLocalCrossInstanceSearch(ctx, {
      query: "remote",
      surface: "code",
      limit: 5,
    });

    expect(search).toHaveBeenCalledWith("remote", 1, 5, undefined);
    expect(result).toEqual({
      instanceId: "monsthera-main",
      surface: "code",
      query: "remote",
      count: 1,
      results: [{
        path: "src/remote.ts",
        score: 0.912,
        snippet: "export const remote = true;",
        matchLines: [3, 4],
      }],
    });
  });

  it("queries eligible peers, signs requests, and preserves provenance", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual(expect.objectContaining({
        "content-type": "application/json",
        "x-monsthera-instance-id": "monsthera-main",
      }));
      expect(String(init?.headers && Reflect.get(init.headers, "x-monsthera-signature"))).toMatch(/^v1=/);

      return new Response(JSON.stringify({
        instanceId: "monsthera-docs",
        surface: "knowledge",
        query: "auth",
        count: 1,
        results: [{
          key: "decision:remote-auth",
          title: "Remote Auth",
          type: "decision",
          scope: "repo",
          updatedAt: "2026-03-11T12:00:00.000Z",
          score: 0.88,
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const ctx = {
      config: {
        crossInstance: {
          enabled: true,
          instanceId: "monsthera-main",
          peers: [
            {
              instanceId: "monsthera-docs",
              baseUrl: "https://docs.example.test",
              enabled: true,
              sharedSecret: "1234567890abcdef",
              allowedCapabilities: ["read_knowledge"],
            },
            {
              instanceId: "monsthera-code",
              baseUrl: "https://code.example.test",
              enabled: true,
              sharedSecret: "abcdef1234567890",
              allowedCapabilities: ["read_code"],
            },
          ],
        },
      },
    } as unknown as MonstheraContext;

    const result = await searchAcrossRemoteInstances(ctx, {
      query: "auth",
      surface: "knowledge",
      limit: 5,
    }, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.failures).toEqual([]);
    expect(result.results).toEqual([expect.objectContaining({
      key: "decision:remote-auth",
      provenance: {
        instanceId: "monsthera-docs",
        baseUrl: "https://docs.example.test",
      },
    })]);
  });

  it("degrades gracefully when one remote fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("docs.example.test")) {
        return new Response(JSON.stringify({
          instanceId: "monsthera-docs",
          surface: "code",
          query: "graph",
          count: 1,
          results: [{
            path: "src/graph.ts",
            score: 0.77,
            snippet: "renderGraph()",
            matchLines: [12],
          }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error("connect ECONNREFUSED");
    });

    const ctx = {
      config: {
        crossInstance: {
          enabled: true,
          instanceId: "monsthera-main",
          peers: [
            {
              instanceId: "monsthera-docs",
              baseUrl: "https://docs.example.test",
              enabled: true,
              sharedSecret: "1234567890abcdef",
              allowedCapabilities: ["read_code"],
            },
            {
              instanceId: "monsthera-broken",
              baseUrl: "https://broken.example.test",
              enabled: true,
              sharedSecret: "abcdef1234567890",
              allowedCapabilities: ["read_code"],
            },
          ],
        },
      },
    } as unknown as MonstheraContext;

    const result = await searchAcrossRemoteInstances(ctx, {
      query: "graph",
      surface: "code",
      limit: 5,
    }, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.results).toHaveLength(1);
    expect(result.failures).toEqual([{
      instanceId: "monsthera-broken",
      baseUrl: "https://broken.example.test",
      reason: "connect ECONNREFUSED",
    }]);
  });
});
