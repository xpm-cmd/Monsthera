import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../../src/core/errors.js";
import { executeSelfUpdate } from "../../../src/ops/self-service.js";

async function tempRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "monsthera-self-"));
}

describe("self service", () => {
  it("refuses to execute an update when the install path has blockers", async () => {
    const installPath = await tempRepo();
    const repoPath = await tempRepo();

    const result = await executeSelfUpdate({ installPath, repoPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(result.error.details?.["blockers"]).toContain("installation is not a git checkout");
  });
});
