/**
 * Ticket size classification and model tier routing.
 *
 * Classifies tickets as XS/S/M/L/XL based on scope (affected paths, description length),
 * then maps each size to a model tier for cost-effective agent spawning.
 */

export type TicketSize = "XS" | "S" | "M" | "L" | "XL";
export type ModelTier = "fast" | "standard" | "premium";

export interface TicketSizeInput {
  affectedPaths: string[];
  description: string;
  dependsOn: number[];
  tags: string[];
}

export interface ModelRoutingConfig {
  /** Map from size to model identifier (e.g., "claude-haiku", "claude-sonnet", "claude-opus") */
  tiers: Record<ModelTier, string>;
  /** Override: map from size directly to model. Takes precedence over tier mapping. */
  sizeOverrides?: Partial<Record<TicketSize, string>>;
}

const SIZE_TO_TIER: Record<TicketSize, ModelTier> = {
  XS: "fast",
  S: "fast",
  M: "standard",
  L: "premium",
  XL: "premium",
};

const DEFAULT_TIERS: Record<ModelTier, string> = {
  fast: "haiku",
  standard: "sonnet",
  premium: "opus",
};

/**
 * Classify a ticket's size based on its scope.
 *
 * - XS: 1 file, short description (config flip, typo fix)
 * - S:  1-2 files, moderate description (new query, small feature)
 * - M:  3-5 files, cross-cutting (feature with tests)
 * - L:  6-10 files, architectural (refactor, new subsystem)
 * - XL: 10+ files, multi-module (major redesign)
 */
export function classifyTicketSize(input: TicketSizeInput): TicketSize {
  const pathCount = input.affectedPaths.length;
  const descLength = input.description.length;
  const depCount = input.dependsOn.length;

  // XS: trivial — 0-1 files, short description, no dependencies
  if (pathCount <= 1 && descLength < 200 && depCount === 0) return "XS";

  // S: small — 1-2 files, moderate scope
  if (pathCount <= 2 && descLength < 500) return "S";

  // L: large — 6-10 files or long description with many deps
  if (pathCount >= 6 && pathCount <= 10) return "L";
  if (pathCount >= 4 && descLength > 1000 && depCount >= 3) return "L";

  // XL: massive — 10+ files
  if (pathCount > 10) return "XL";

  // M: medium — everything else (3-5 files, cross-cutting)
  return "M";
}

/**
 * Resolve the model identifier for a given ticket size using routing config.
 */
export function resolveModelForSize(
  size: TicketSize,
  config?: ModelRoutingConfig,
): string {
  // Check direct size override first
  if (config?.sizeOverrides?.[size]) {
    return config.sizeOverrides[size]!;
  }

  const tier = SIZE_TO_TIER[size];
  const tiers = config?.tiers ?? DEFAULT_TIERS;
  return tiers[tier] ?? DEFAULT_TIERS[tier];
}

/**
 * Parse a model routing spec from CLI flag value.
 *
 * Formats:
 * - "auto" — use default tiers (haiku/sonnet/opus)
 * - "fast=haiku,standard=sonnet,premium=opus" — custom tier mapping
 * - "XS=haiku,S=haiku,M=sonnet,L=opus,XL=opus" — direct size mapping
 */
export function parseModelRoutingConfig(spec: string): ModelRoutingConfig {
  if (spec === "auto") {
    return { tiers: { ...DEFAULT_TIERS } };
  }

  const tiers = { ...DEFAULT_TIERS };
  const sizeOverrides: Partial<Record<TicketSize, string>> = {};

  for (const pair of spec.split(",")) {
    const [key, value] = pair.split("=").map((s) => s.trim());
    if (!key || !value) continue;

    const upperKey = key.toUpperCase();
    if (upperKey === "FAST" || upperKey === "STANDARD" || upperKey === "PREMIUM") {
      tiers[upperKey.toLowerCase() as ModelTier] = value;
    } else if (["XS", "S", "M", "L", "XL"].includes(upperKey)) {
      sizeOverrides[upperKey as TicketSize] = value;
    }
  }

  return { tiers, sizeOverrides: Object.keys(sizeOverrides).length > 0 ? sizeOverrides : undefined };
}
