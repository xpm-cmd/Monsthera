import { describe, expect, it } from "vitest";
import {
  ClaimPathsSchema,
  FlatMetadataSchema,
  TagsSchema,
  TicketIdSchema,
  parseFlatPrimitiveRecordJson,
  parseStringArrayJson,
} from "../../../src/core/input-hardening.js";

describe("input hardening helpers", () => {
  it("rejects oversized tag entries", () => {
    const parsed = TagsSchema.safeParse(["ok", "x".repeat(65)]);
    expect(parsed.success).toBe(false);
  });

  it("rejects nested metadata objects and excessive keys", () => {
    const nested = FlatMetadataSchema.safeParse({
      scope: "ticket",
      context: { nested: true },
    });
    expect(nested.success).toBe(false);

    const tooManyKeys = FlatMetadataSchema.safeParse(
      Object.fromEntries(Array.from({ length: 21 }, (_, idx) => [`k${idx}`, idx])),
    );
    expect(tooManyKeys.success).toBe(false);
  });

  it("validates ticket ids and bounded path arrays", () => {
    expect(TicketIdSchema.safeParse("TKT-1234abcd").success).toBe(true);
    expect(TicketIdSchema.safeParse("ticket-123").success).toBe(false);
    expect(ClaimPathsSchema.safeParse(Array.from({ length: 51 }, (_, idx) => `src/file-${idx}.ts`)).success).toBe(false);
  });

  it("falls back safely for malformed JSON arrays and records", () => {
    expect(parseStringArrayJson("{bad json")).toEqual([]);
    expect(parseStringArrayJson(JSON.stringify(["ok", 1, "", "trimmed  "]), {
      maxItems: 3,
      maxItemLength: 10,
    })).toEqual([]);

    expect(parseFlatPrimitiveRecordJson("{bad json")).toEqual({});
    expect(parseFlatPrimitiveRecordJson(JSON.stringify({
      ok: "value",
      count: 2,
      enabled: true,
      nested: { bad: true },
      tooLong: "x".repeat(1001),
    }))).toEqual({});
  });
});
