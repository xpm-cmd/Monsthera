import { describe, it, expect } from "vitest";
import { createDatabase } from "../../../src/db/client.js";

describe("client", () => {
  describe("createDatabase", () => {
    it("should be callable", () => {
      expect(createDatabase).toBeDefined();
    });
  });

});
