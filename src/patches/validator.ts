import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { parseStringArrayJson } from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import { getHead } from "../git/operations.js";
import { scanForSecrets, type SecretPattern } from "../trust/secret-patterns.js";

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
  input: { diff: string; message: string; baseCommit: string; bundleId?: string; secretPatterns?: SecretPattern[] },
): Promise<PatchValidation> {
  const currentHead = await getHead({ cwd: repoPath });
  const proposalId = `patch-${randomUUID().slice(0, 12)}`;

  // Invariant 3: Reject if HEAD !== baseCommit
  const stale = currentHead !== input.baseCommit;

  // Extract touched paths from diff headers
  const touchedPaths = extractTouchedPaths(input.diff);

  // Check for secrets in diff
  const secretWarnings: string[] = [];
  const secretHits = scanForSecrets(input.diff, input.secretPatterns);
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
    const claimed = parseStringArrayJson(session.claimedFilesJson, {
      maxItems: 50,
      maxItemLength: 500,
    });
    for (const path of touchedPaths) {
      if (claimed.includes(path)) {
        policyViolations.push(`File ${path} claimed by agent ${session.agentId}`);
      }
    }
  }

  // Check protected artifacts
  const protectedRules = queries.getProtectedArtifacts(db, repoId);
  for (const rule of protectedRules) {
    for (const path of touchedPaths) {
      if (matchesProtectedPattern(path, rule.pathPattern)) {
        policyViolations.push(`Protected artifact: ${path} matches rule "${rule.pathPattern}" (${rule.reason})`);
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

/**
 * Match a file path against a protected artifact pattern.
 * Supports: exact match, directory prefix with trailing slash,
 * and simple glob with trailing wildcard (*).
 */
export function matchesProtectedPattern(filePath: string, pattern: string): boolean {
  // Exact match
  if (filePath === pattern) return true;

  // Directory prefix: "src/db/" matches "src/db/schema.ts"
  if (pattern.endsWith("/") && filePath.startsWith(pattern)) return true;

  // Trailing wildcard: "src/db/*" matches "src/db/schema.ts"
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return filePath.startsWith(prefix);
  }

  return false;
}
