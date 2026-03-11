import { z } from "zod/v4";

export const CouncilSpecializationId = z.enum([
  "architect",
  "simplifier",
  "security",
  "performance",
  "patterns",
]);
export type CouncilSpecializationId = z.infer<typeof CouncilSpecializationId>;

export const COUNCIL_SPECIALIZATIONS = CouncilSpecializationId.options;
