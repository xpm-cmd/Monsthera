import { createHash, randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import { getHead } from "../git/operations.js";
import { scanForSecrets } from "../trust/secret-patterns.js";

export interface DryRunResult {
  feasible: boolean;
  touchedPaths: string[];
  policyViolations: string[];
  secretWarnings: string[];
  reindexScope: number;
}

export interface PatchValidation {
  valid: boolean;
  stale: boolean;
  proposalId: string;
  dryRunResult: DryRunResult;
  currentHead: string;
}

export async function validatePatch(
  db: BetterSQLite3Database<typeof schema>,
  repoPath: string,
  repoId: number,
  input: { diff: string; message: string; baseCommit: string; bundleId?: string },
): Promise<PatchValidation> {
  const currentHead = await getHead({ cwd: repoPath });
  const proposalId = `patch-${randomUUID().slice(0, 12)}`;

  // Invariant 3: Reject if HEAD !== baseCommit
  const stale = currentHead !== input.baseCommit;

  // Extract touched paths from diff headers
  const touchedPaths = extractTouchedPaths(input.diff);

  // Check for secrets in diff
  const secretWarnings: string[] = [];
  const secretHits = scanForSecrets(input.diff);
  if (secretHits.length > 0) {
    for (const hit of secretHits) {
      secretWarnings.push(`${hit.pattern} detected at diff line ${hit.line}`);
    }
  }

  // Check for policy violations
  const policyViolations: string[] = [];

  // Check file claim conflicts
  const activeSessions = queries.getActiveSessions(db);
  for (const session of activeSessions) {
    const claimed = session.claimedFilesJson
      ? (JSON.parse(session.claimedFilesJson) as string[])
      : [];
    for (const path of touchedPaths) {
      if (claimed.includes(path)) {
        policyViolations.push(`File ${path} claimed by agent ${session.agentId}`);
      }
    }
  }

  const dryRunResult: DryRunResult = {
    feasible: !stale && policyViolations.length === 0,
    touchedPaths,
    policyViolations,
    secretWarnings,
    reindexScope: touchedPaths.length,
  };

  return {
    valid: !stale,
    stale,
    proposalId,
    dryRunResult,
    currentHead,
  };
}

function extractTouchedPaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    // +++ b/path or --- a/path
    const match = line.match(/^[+-]{3}\s+[ab]\/(.+)$/);
    if (match && match[1]) {
      paths.add(match[1]);
    }
  }
  return [...paths];
}
