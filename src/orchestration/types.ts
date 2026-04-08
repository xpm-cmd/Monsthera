import type { WorkPhase } from "../core/types.js";
import type { WorkArticle } from "../work/repository.js";

export interface GuardResult {
  readonly name: string;
  readonly passed: boolean;
}

export interface ReadinessReport {
  readonly workId: string;
  readonly currentPhase: WorkPhase;
  readonly nextPhase: WorkPhase | null;
  readonly ready: boolean;
  readonly guardResults: readonly GuardResult[];
}

export interface AdvanceResult {
  readonly workId: string;
  readonly from: WorkPhase;
  readonly to: WorkPhase;
  readonly article: WorkArticle;
}

export interface WavePlan {
  readonly items: ReadonlyArray<{
    readonly workId: string;
    readonly from: WorkPhase;
    readonly to: WorkPhase;
  }>;
  readonly blockedItems: ReadonlyArray<{
    readonly workId: string;
    readonly reason: string;
  }>;
}

export interface WaveResult {
  readonly advanced: readonly AdvanceResult[];
  readonly failed: ReadonlyArray<{ readonly workId: string; readonly error: string }>;
}
