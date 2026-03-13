import { z } from "zod/v4";
import { CouncilSpecializationId } from "../../schemas/council.js";

export type WorkflowYamlValue =
  | string
  | number
  | boolean
  | null
  | WorkflowYamlValue[]
  | { [key: string]: WorkflowYamlValue };

const WorkflowYamlScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const WorkflowYamlValueSchema: z.ZodType<WorkflowYamlValue> = z.lazy(() => z.union([
  WorkflowYamlScalarSchema,
  z.array(WorkflowYamlValueSchema),
  z.record(z.string(), WorkflowYamlValueSchema),
]));

export const WorkflowYamlObjectSchema = z.record(z.string(), WorkflowYamlValueSchema);

const WorkflowNameSchema = z.string().trim().min(1).max(120).regex(
  /^(?:custom:)?[A-Za-z0-9][A-Za-z0-9_-]*$/,
  "Workflow name must be alphanumeric and may include - or _",
);

const WorkflowOutputKeySchema = z.string().trim().min(1).max(80).regex(
  /^[A-Za-z][A-Za-z0-9_-]*$/,
  "Step output keys must start with a letter and may include - or _",
);

const StepWithOutputSchema = z.object({
  output: WorkflowOutputKeySchema.optional(),
  key: WorkflowOutputKeySchema.optional(),
  description: z.string().trim().min(1).max(500).optional(),
  condition: z.string().trim().min(1).max(500).optional(),
}).superRefine((value, ctx) => {
  if (!value.output && !value.key) {
    ctx.addIssue({
      code: "custom",
      path: ["output"],
      message: "Each workflow step must declare an output key via `output` or `key`",
    });
  }
});

export const WorkflowYamlToolStepSchema = StepWithOutputSchema.extend({
  type: z.literal("tool").optional(),
  tool: z.string().trim().min(1),
  input: WorkflowYamlObjectSchema.default({}),
  onError: z.enum(["stop", "continue"]).optional(),
  forEach: z.string().trim().min(1).max(500).optional(),
}).strict();

export const WorkflowYamlQuorumStepSchema = StepWithOutputSchema.extend({
  type: z.literal("quorum_checkpoint"),
  input: z.object({
    ticketId: z.string().trim().min(1),
    roles: z.array(CouncilSpecializationId).max(6).optional(),
    requiredPasses: z.union([z.number().int().min(1), z.string().trim().min(1)]).optional(),
    timeout: z.union([z.number().int().min(0), z.string().trim().min(1)]),
    onFail: z.enum(["block", "continue_with_warning"]).optional(),
    pollIntervalMs: z.union([z.number().int().min(1), z.string().trim().min(1)]).optional(),
  }).strict(),
}).strict();

export const WorkflowYamlStepSchema = z.union([
  WorkflowYamlToolStepSchema,
  WorkflowYamlQuorumStepSchema,
]);

export const WorkflowYamlSchema = z.object({
  name: WorkflowNameSchema,
  description: z.string().trim().min(1).max(500).optional(),
  params: z.array(z.string().trim().min(1)).max(50).optional(),
  requiredParams: z.array(z.string().trim().min(1)).max(50).optional(),
  defaults: WorkflowYamlObjectSchema.default({}),
  steps: z.array(WorkflowYamlStepSchema).min(1).max(20),
}).strict();

export type WorkflowYamlDocument = z.infer<typeof WorkflowYamlSchema>;
