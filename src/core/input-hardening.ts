import { z } from "zod/v4";

export const MAX_ACTOR_ID_LENGTH = 100;
export const MAX_TICKET_ID_LENGTH = 40;
export const MAX_KNOWLEDGE_KEY_LENGTH = 120;
export const MAX_TAG_LENGTH = 64;
export const MAX_TAG_COUNT = 25;
export const MAX_PATH_LENGTH = 500;
export const MAX_AFFECTED_PATH_COUNT = 100;
export const MAX_LINKED_PATH_COUNT = 50;
export const MAX_CLAIM_PATH_COUNT = 50;
export const MAX_METADATA_KEY_LENGTH = 100;
export const MAX_METADATA_VALUE_LENGTH = 1_000;
export const MAX_METADATA_KEYS = 20;
export const MAX_TICKET_LONG_TEXT_LENGTH = 8_000;

export type FlatPrimitive = string | number | boolean | null;

export const AgentIdSchema = z.string().min(1).max(MAX_ACTOR_ID_LENGTH);
export const SessionIdSchema = z.string().min(1).max(MAX_ACTOR_ID_LENGTH);
export const KnowledgeKeySchema = z.string().min(3).max(MAX_KNOWLEDGE_KEY_LENGTH);
export const TicketIdSchema = z
  .string()
  .min(8)
  .max(MAX_TICKET_ID_LENGTH)
  .regex(/^TKT-[A-Za-z0-9_-]+$/);
export const TagSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);
export const TagsSchema = boundedStringArraySchema({
  maxItems: MAX_TAG_COUNT,
  maxItemLength: MAX_TAG_LENGTH,
});
export const FilePathSchema = z.string().trim().min(1).max(MAX_PATH_LENGTH);
export const AffectedPathsSchema = boundedStringArraySchema({
  maxItems: MAX_AFFECTED_PATH_COUNT,
  maxItemLength: MAX_PATH_LENGTH,
});
export const LinkedPathsSchema = boundedStringArraySchema({
  maxItems: MAX_LINKED_PATH_COUNT,
  maxItemLength: MAX_PATH_LENGTH,
});
export const ClaimPathsSchema = boundedStringArraySchema({
  minItems: 1,
  maxItems: MAX_CLAIM_PATH_COUNT,
  maxItemLength: MAX_PATH_LENGTH,
});
export const FlatPrimitiveValueSchema = z.union([
  z.string().max(MAX_METADATA_VALUE_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const FlatMetadataSchema = z
  .record(z.string().trim().min(1).max(MAX_METADATA_KEY_LENGTH), FlatPrimitiveValueSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > MAX_METADATA_KEYS) {
      ctx.addIssue({
        code: "custom",
        message: `Metadata supports at most ${MAX_METADATA_KEYS} keys`,
      });
    }
  });

export function boundedStringArraySchema(opts: {
  minItems?: number;
  maxItems: number;
  maxItemLength: number;
}) {
  let schema = z.array(z.string().trim().min(1).max(opts.maxItemLength)).max(opts.maxItems);
  if (opts.minItems !== undefined) {
    schema = schema.min(opts.minItems);
  }
  return schema;
}

export function parseStringArrayJson(
  raw: string | null | undefined,
  opts: { maxItems?: number; maxItemLength?: number } = {},
): string[] {
  const maxItems = opts.maxItems ?? Number.POSITIVE_INFINITY;
  const maxItemLength = opts.maxItemLength ?? Number.POSITIVE_INFINITY;
  return parseJsonWithSchema(
    raw,
    boundedStringArraySchema({ maxItems, maxItemLength }),
    [],
  );
}

export function parseFlatPrimitiveRecordJson(
  raw: string | null | undefined,
  opts: { maxKeys?: number; maxKeyLength?: number; maxStringLength?: number } = {},
): Record<string, FlatPrimitive> {
  const maxKeys = opts.maxKeys ?? MAX_METADATA_KEYS;
  const maxKeyLength = opts.maxKeyLength ?? MAX_METADATA_KEY_LENGTH;
  const maxStringLength = opts.maxStringLength ?? MAX_METADATA_VALUE_LENGTH;
  return parseJsonWithSchema(
    raw,
    flatPrimitiveRecordSchema({ maxKeys, maxKeyLength, maxStringLength }),
    {},
  );
}

export function parseJsonWithSchema<T>(
  raw: string | null | undefined,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  const parsed = safeParseJson(raw);
  if (parsed === null) return fallback;
  const result = schema.safeParse(parsed);
  return result.success ? result.data : fallback;
}

function safeParseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function flatPrimitiveRecordSchema(opts: {
  maxKeys: number;
  maxKeyLength: number;
  maxStringLength: number;
}) {
  return z
    .record(
      z.string().trim().min(1).max(opts.maxKeyLength),
      z.union([
        z.string().max(opts.maxStringLength),
        z.number().finite(),
        z.boolean(),
        z.null(),
      ]),
    )
    .superRefine((value, ctx) => {
      if (Object.keys(value).length > opts.maxKeys) {
        ctx.addIssue({
          code: "custom",
          message: `Metadata supports at most ${opts.maxKeys} keys`,
        });
      }
    });
}
