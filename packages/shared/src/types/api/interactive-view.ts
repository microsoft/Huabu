// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

export type InteractiveViewJsonValue =
  | string
  | number
  | boolean
  | null
  | InteractiveViewJsonValue[]
  | { [key: string]: InteractiveViewJsonValue };

export const interactiveViewJsonValueSchema: z.ZodType<InteractiveViewJsonValue> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(interactiveViewJsonValueSchema),
      z.record(z.string(), interactiveViewJsonValueSchema),
    ]),
  );

const MAX_INTERACTIVE_VIEW_JSON_DEPTH = 32;
const MAX_INTERACTIVE_VIEW_JSON_NODES = 10_000;
const MAX_INTERACTIVE_VIEW_JSON_COLLECTION_SIZE = 1_000;
const MAX_INTERACTIVE_VIEW_JSON_STRING_LENGTH = 65_536;

export function validateInteractiveViewJsonBounds(
  value: unknown,
): string | null {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited += 1;
    if (visited > MAX_INTERACTIVE_VIEW_JSON_NODES) {
      return 'JSON input contains too many values';
    }
    if (current.depth > MAX_INTERACTIVE_VIEW_JSON_DEPTH) {
      return 'JSON input is nested too deeply';
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_INTERACTIVE_VIEW_JSON_STRING_LENGTH) {
        return 'JSON input contains an oversized string';
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_INTERACTIVE_VIEW_JSON_COLLECTION_SIZE) {
        return 'JSON input contains an oversized array';
      }
      for (const entry of current.value) {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof current.value !== 'object') {
      return 'Input must contain only JSON values';
    }
    const entries = Object.entries(current.value);
    if (entries.length > MAX_INTERACTIVE_VIEW_JSON_COLLECTION_SIZE) {
      return 'JSON input contains an oversized object';
    }
    for (const [key, entry] of entries) {
      if (key.length > 1_024) return 'JSON input contains an oversized key';
      pending.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return null;
}

const stringStateSchema = z
  .object({
    type: z.literal('string'),
    enum: z.array(z.string()).min(1).optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().max(65_536).optional(),
  })
  .strict();

const numberStateSchema = z
  .object({
    type: z.literal('number'),
    enum: z.array(z.number().finite()).min(1).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  })
  .strict();

const booleanStateSchema = z
  .object({
    type: z.literal('boolean'),
  })
  .strict();

const nullStateSchema = z
  .object({
    type: z.literal('null'),
  })
  .strict();

export type InteractiveViewStateSchemaV1 =
  | z.infer<typeof stringStateSchema>
  | z.infer<typeof numberStateSchema>
  | z.infer<typeof booleanStateSchema>
  | z.infer<typeof nullStateSchema>
  | {
      type: 'array';
      items: InteractiveViewStateSchemaV1;
      minItems?: number;
      maxItems?: number;
    }
  | {
      type: 'object';
      properties: Record<string, InteractiveViewStateSchemaV1>;
      required?: string[];
      additionalProperties: false;
    };

export const interactiveViewStateSchemaV1Schema: z.ZodType<InteractiveViewStateSchemaV1> =
  z.lazy(() =>
    z.discriminatedUnion('type', [
      stringStateSchema,
      numberStateSchema,
      booleanStateSchema,
      nullStateSchema,
      z
        .object({
          type: z.literal('array'),
          items: interactiveViewStateSchemaV1Schema,
          minItems: z.number().int().nonnegative().optional(),
          maxItems: z.number().int().positive().max(1_000).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal('object'),
          properties: z.record(
            z.string().min(1).max(128),
            interactiveViewStateSchemaV1Schema,
          ),
          required: z.array(z.string().min(1).max(128)).optional(),
          additionalProperties: z.literal(false),
        })
        .strict(),
    ]),
  );

export const interactiveViewDataBindingV1Schema = z
  .object({
    bindingId: z.string().min(1).max(128),
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('canvas.task-store'),
          recentRunLimit: z.number().int().positive().max(100),
        })
        .strict(),
      z
        .object({
          kind: z.literal('canvas.nodes'),
          nodeIds: z.array(z.string().min(1)).min(1).max(100),
        })
        .strict(),
    ]),
    refresh: z
      .object({
        onMount: z.boolean().default(true),
        onFocus: z.boolean().default(true),
        pollIntervalMs: z.number().int().min(1_000).max(60_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type InteractiveViewDataBindingV1 = z.infer<
  typeof interactiveViewDataBindingV1Schema
>;

export const INTERACTIVE_VIEW_ACTION_KINDS = [
  'state.replace',
  'data.refresh',
  'agent.submit',
  'navigation.open-node',
  'navigation.open-thread',
] as const;
export type InteractiveViewActionKindV1 =
  (typeof INTERACTIVE_VIEW_ACTION_KINDS)[number];

export const interactiveViewActionGrantV1Schema = z
  .object({
    actionId: z.string().min(1).max(128),
    kind: z.enum(INTERACTIVE_VIEW_ACTION_KINDS),
    bindingId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type InteractiveViewActionGrantV1 = z.infer<
  typeof interactiveViewActionGrantV1Schema
>;

export const interactiveViewDefinitionV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    ownerThreadId: z.string().min(1),
    state: z
      .object({
        schema: interactiveViewStateSchemaV1Schema,
        value: interactiveViewJsonValueSchema,
      })
      .strict(),
    bindings: z.array(interactiveViewDataBindingV1Schema).max(20),
    actions: z.array(interactiveViewActionGrantV1Schema).max(50),
  })
  .strict();
export type InteractiveViewDefinitionV1 = z.infer<
  typeof interactiveViewDefinitionV1Schema
>;

const pointSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

export const interactiveViewCanvasParamsSchema = z
  .object({
    canvasId: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict();

export const interactiveViewResourceParamsSchema =
  interactiveViewCanvasParamsSchema
    .extend({
      nodeId: z
        .string()
        .min(1)
        .regex(/^[a-zA-Z0-9_-]+$/),
    })
    .strict();

export const createInteractiveViewRequestSchema = z
  .object({
    rendererArtifact: z
      .string()
      .min(1)
      .max(255)
      .regex(/^(?:upload\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*\.html?$/i),
    viewKey: z.string().min(1).max(128).optional(),
    label: z.string().min(1).max(256).optional(),
    ownerThreadId: z.string().min(1),
    state: z
      .object({
        schema: interactiveViewStateSchemaV1Schema,
        value: interactiveViewJsonValueSchema,
      })
      .strict(),
    bindings: z.array(interactiveViewDataBindingV1Schema).max(20).default([]),
    actions: z.array(interactiveViewActionGrantV1Schema).max(50).default([]),
    position: pointSchema,
    size: z
      .object({
        width: z.number().positive().max(4_096),
        height: z.number().positive().max(4_096),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CreateInteractiveViewRequest = z.infer<
  typeof createInteractiveViewRequestSchema
>;

export const interactiveViewLookupQuerySchema = z
  .object({
    viewKey: z.string().min(1).max(128).optional(),
  })
  .strict();
export type InteractiveViewLookupQuery = z.infer<
  typeof interactiveViewLookupQuerySchema
>;

export const replaceInteractiveViewStateRequestSchema = z
  .object({
    revision: z.string().min(1),
    value: interactiveViewJsonValueSchema,
  })
  .strict();
export type ReplaceInteractiveViewStateRequest = z.infer<
  typeof replaceInteractiveViewStateRequestSchema
>;

export const interactiveViewResourceSchema = z
  .object({
    nodeId: z.string().min(1),
    viewKey: z.string().min(1).optional(),
    rendererArtifact: z.string().min(1),
    revision: z.string().min(1),
    definition: interactiveViewDefinitionV1Schema,
  })
  .strict();
export type InteractiveViewResource = z.infer<
  typeof interactiveViewResourceSchema
>;

export const interactiveViewListResponseSchema = z
  .object({
    views: z.array(interactiveViewResourceSchema),
  })
  .strict();
export type InteractiveViewListResponse = z.infer<
  typeof interactiveViewListResponseSchema
>;

export const interactiveViewDataSnapshotV1Schema = z
  .object({
    revision: z.string().min(1),
    value: interactiveViewJsonValueSchema,
    references: z
      .object({
        nodeIds: z.array(z.string().min(1)).max(1_000),
        threadIds: z.array(z.string().min(1)).max(1_000),
      })
      .strict(),
  })
  .strict();
export type InteractiveViewDataSnapshotV1 = z.infer<
  typeof interactiveViewDataSnapshotV1Schema
>;

export const interactiveViewRuntimeSnapshotSchema = z
  .object({
    resource: interactiveViewResourceSchema,
    data: z.record(z.string(), interactiveViewDataSnapshotV1Schema),
  })
  .strict();
export type InteractiveViewRuntimeSnapshot = z.infer<
  typeof interactiveViewRuntimeSnapshotSchema
>;

export const interactiveViewBootstrapV1Schema = z
  .object({
    type: z.literal('huabu.view.bootstrap'),
    protocolVersion: z.literal(1),
    nodeId: z.string().min(1),
    revision: z.string().min(1),
    state: interactiveViewJsonValueSchema,
    data: z.record(z.string(), interactiveViewDataSnapshotV1Schema),
    actions: z.array(
      z
        .object({
          actionId: z.string().min(1),
          kind: z.enum(INTERACTIVE_VIEW_ACTION_KINDS),
        })
        .strict(),
    ),
  })
  .strict();
export type InteractiveViewBootstrapV1 = z.infer<
  typeof interactiveViewBootstrapV1Schema
>;

export const interactiveViewIntentV1Schema = z
  .object({
    type: z.literal('huabu.view.intent'),
    protocolVersion: z.literal(1),
    nodeId: z.string().min(1),
    requestId: z.string().min(1).max(128),
    actionId: z.string().min(1).max(128),
    bindingRevision: z.string().min(1).optional(),
    input: interactiveViewJsonValueSchema.optional(),
  })
  .strict();
export type InteractiveViewIntentV1 = z.infer<
  typeof interactiveViewIntentV1Schema
>;

export const interactiveViewAgentEventV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    nodeId: z.string().min(1),
    actionId: z.string().min(1).max(128),
    input: interactiveViewJsonValueSchema.optional(),
    viewRevision: z.string().min(1),
  })
  .strict();
export type InteractiveViewAgentEventV1 = z.infer<
  typeof interactiveViewAgentEventV1Schema
>;

export const interactiveViewActionRequestSchema = z
  .object({
    input: z
      .custom<InteractiveViewJsonValue>()
      .superRefine((value, context) => {
        const issue = validateInteractiveViewJsonBounds(value);
        if (issue) context.addIssue({ code: 'custom', message: issue });
      })
      .optional(),
  })
  .strict();
export type InteractiveViewActionRequest = z.infer<
  typeof interactiveViewActionRequestSchema
>;

export const interactiveViewActionResponseSchema = z
  .object({
    accepted: z.literal(true),
  })
  .strict();
export type InteractiveViewActionResponse = z.infer<
  typeof interactiveViewActionResponseSchema
>;

export const interactiveViewDataUpdateV1Schema = z
  .object({
    type: z.literal('huabu.view.data'),
    protocolVersion: z.literal(1),
    nodeId: z.string().min(1),
    data: z.record(z.string(), interactiveViewDataSnapshotV1Schema),
  })
  .strict();
export type InteractiveViewDataUpdateV1 = z.infer<
  typeof interactiveViewDataUpdateV1Schema
>;

export type InteractiveViewOutcomeV1 =
  | {
      type: 'huabu.view.outcome';
      requestId: string;
      status: 'pending';
    }
  | {
      type: 'huabu.view.outcome';
      requestId: string;
      status: 'success';
      result?: InteractiveViewJsonValue;
    }
  | {
      type: 'huabu.view.outcome';
      requestId: string;
      status: 'error' | 'conflict' | 'unauthorized';
      code: string;
      message: string;
      currentRevision?: string;
    };

export function validateInteractiveViewStateSchema(
  schema: InteractiveViewStateSchemaV1,
  path = '$',
): string | null {
  switch (schema.type) {
    case 'string':
      if (
        schema.minLength !== undefined &&
        schema.maxLength !== undefined &&
        schema.minLength > schema.maxLength
      ) {
        return `${path}.minLength must not exceed maxLength`;
      }
      return null;
    case 'number':
      if (
        schema.minimum !== undefined &&
        schema.maximum !== undefined &&
        schema.minimum > schema.maximum
      ) {
        return `${path}.minimum must not exceed maximum`;
      }
      return null;
    case 'boolean':
    case 'null':
      return null;
    case 'array':
      if (
        schema.minItems !== undefined &&
        schema.maxItems !== undefined &&
        schema.minItems > schema.maxItems
      ) {
        return `${path}.minItems must not exceed maxItems`;
      }
      return validateInteractiveViewStateSchema(schema.items, `${path}.items`);
    case 'object': {
      for (const required of schema.required ?? []) {
        if (!(required in schema.properties)) {
          return `${path}.required references undeclared property "${required}"`;
        }
      }
      for (const [key, property] of Object.entries(schema.properties)) {
        const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (
          /(?:password|passwd|secret|token|apikey|privatekey|credentials?)$/.test(
            normalizedKey,
          )
        ) {
          return `${path}.properties.${key} is a prohibited secret field`;
        }
        const issue = validateInteractiveViewStateSchema(
          property,
          `${path}.properties.${key}`,
        );
        if (issue) return issue;
      }
      return null;
    }
  }
}

export function validateInteractiveViewState(
  schema: InteractiveViewStateSchemaV1,
  value: InteractiveViewJsonValue,
  path = '$',
): string | null {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string`;
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path} must contain at least ${schema.minLength} characters`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path} must contain at most ${schema.maxLength} characters`;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path} must be one of the declared values`;
      }
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${path} must be a finite number`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${path} must be at least ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${path} must be at most ${schema.maximum}`;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path} must be one of the declared values`;
      }
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be a boolean`;
    case 'null':
      return value === null ? null : `${path} must be null`;
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} must contain at least ${schema.minItems} items`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} must contain at most ${schema.maxItems} items`;
      }
      for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        if (entry === undefined) return `${path}[${index}] must be valid JSON`;
        const issue = validateInteractiveViewState(
          schema.items,
          entry,
          `${path}[${index}]`,
        );
        if (issue) return issue;
      }
      return null;
    }
    case 'object': {
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        return `${path} must be an object`;
      }
      for (const required of schema.required ?? []) {
        if (!(required in value)) return `${path}.${required} is required`;
      }
      for (const [key, entry] of Object.entries(value)) {
        const propertySchema = schema.properties[key];
        if (!propertySchema) {
          return `${path}.${key} is not a declared property`;
        }
        const issue = validateInteractiveViewState(
          propertySchema,
          entry,
          `${path}.${key}`,
        );
        if (issue) return issue;
      }
      return null;
    }
  }
}

function canonicalJson(value: InteractiveViewJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

export function interactiveViewJsonRevision(
  prefix: string,
  value: InteractiveViewJsonValue,
): string {
  const canonical = canonicalJson(value);
  let hash = 5381;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (hash * 33) ^ canonical.charCodeAt(index);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function interactiveViewRevision(
  definition: InteractiveViewDefinitionV1,
): string {
  return interactiveViewJsonRevision(
    'view',
    definition as unknown as InteractiveViewJsonValue,
  );
}
