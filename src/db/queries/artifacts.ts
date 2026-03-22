import { eq, and, type DB, tables, isMissingTableError } from "./common.js";

export function insertProtectedArtifact(
  db: DB,
  data: { repoId: number; pathPattern: string; reason: string; createdBy: string; createdAt: string },
) {
  return db
    .insert(tables.protectedArtifacts)
    .values(data)
    .returning()
    .get();
}

export function getProtectedArtifacts(db: DB, repoId: number) {
  try {
    return db
      .select()
      .from(tables.protectedArtifacts)
      .where(eq(tables.protectedArtifacts.repoId, repoId))
      .all();
  } catch (error) {
    if (isMissingTableError(error, "protected_artifacts")) return [];
    throw error;
  }
}

export function getProtectedArtifactByPattern(db: DB, repoId: number, pathPattern: string) {
  return db
    .select()
    .from(tables.protectedArtifacts)
    .where(and(eq(tables.protectedArtifacts.repoId, repoId), eq(tables.protectedArtifacts.pathPattern, pathPattern)))
    .get();
}

export function deleteProtectedArtifact(db: DB, repoId: number, pathPattern: string) {
  return db
    .delete(tables.protectedArtifacts)
    .where(and(eq(tables.protectedArtifacts.repoId, repoId), eq(tables.protectedArtifacts.pathPattern, pathPattern)))
    .run();
}
