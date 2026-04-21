// Ad-hoc race verifier: run two contributeEnrichment calls concurrently
// against the SAME service instance (so they share the container, matching
// the MCP server's hot-path). If the code is last-write-wins, the second
// resolve will overwrite the first's mutation and one role ends up still
// "pending".
//
// Run: pnpm exec tsx scripts/race-enrich.ts
//
// This script is not part of the test suite — it is an ad-hoc repro used
// when investigating docs/concurrency-model.md (2026-04-21).
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createContainer } from "../src/core/container.js";
import { defaultConfig } from "../src/core/config.js";

async function main(): Promise<void> {
  const repoPath = path.join("/tmp", `monsthera-race-inproc-${randomUUID()}`);
  await fs.mkdir(repoPath, { recursive: true });

  const config = defaultConfig(repoPath);
  const container = await createContainer(config);

  const ROUNDS = 20;
  let losses = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const created = await container.workService.createWork({
      title: `round-${round}`,
      template: "feature",
      author: "agent-1",
      priority: "medium",
      content: "## Objective\n\nrace\n\n## Acceptance Criteria\n\n- [ ] X\n",
    });
    if (!created.ok) throw new Error(`create round ${round} failed`);
    const id = created.value.id;
    const adv = await container.workService.advancePhase(id, "enrichment");
    if (!adv.ok) throw new Error(`advance round ${round} failed`);

    const [a, b] = await Promise.all([
      container.workService.contributeEnrichment(id, "architecture", "contributed"),
      container.workService.contributeEnrichment(id, "testing", "contributed"),
    ]);
    if (!a.ok || !b.ok) {
      // eslint-disable-next-line no-console
      console.log(`round ${round}: call failed a.ok=${a.ok} b.ok=${b.ok}`);
      continue;
    }

    const fetched = await container.workService.getWork(id);
    if (!fetched.ok) throw new Error(`fetch failed round ${round}`);
    const contributed = fetched.value.enrichmentRoles.filter(
      (r) => r.status === "contributed",
    ).length;
    if (contributed < 2) {
      losses += 1;
      // eslint-disable-next-line no-console
      console.log(
        `round ${round}: LOST WRITE — contributed=${contributed}, roles=${JSON.stringify(
          fetched.value.enrichmentRoles.map((r) => ({ role: r.role, status: r.status })),
        )}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(`round ${round}: survived (contributed=${contributed})`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\nLost writes: ${losses} / ${ROUNDS}`);
  await container.dispose();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
