// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import {
  DATA_NODE_MAX_BYTES,
  isProhibitedSecretFieldName,
  parseAndNormalizeDataNodeContent,
  parseDataNodeSchemaStructure,
  validateAndFormatDataNodeValue,
  validateDataNodeSecretKeys,
  validateInteractiveViewJsonBounds,
  validateInteractiveViewState,
  validateInteractiveViewStateSchema,
} from '../../utils/data-node-validation.js';

import type {
  DataNodeSchemaV1,
  DataNodeValidationResult,
  InteractiveViewJsonValue,
  InteractiveViewStateSchemaV1,
} from '../../utils/data-node-validation.js';

export {
  DATA_NODE_MAX_BYTES,
  isProhibitedSecretFieldName,
  parseAndNormalizeDataNodeContent,
  parseDataNodeSchemaStructure,
  validateAndFormatDataNodeValue,
  validateDataNodeSecretKeys,
  validateInteractiveViewJsonBounds,
  validateInteractiveViewState,
  validateInteractiveViewStateSchema,
};
export type {
  DataNodeSchemaV1,
  DataNodeValidationResult,
  InteractiveViewJsonValue,
  InteractiveViewStateSchemaV1,
};

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
          additionalProperties: z.literal(false).default(false),
        })
        .strict(),
    ]),
  );

export const dataNodeSchemaV1Schema = interactiveViewStateSchemaV1Schema;

/**
 * Non-cyclic transport wrapper for Data Node schemas used inside JSON Schema
 * tool definitions (`z.toJSONSchema(..., { reused: 'inline' })`), while still
 * running full recursive `DataNodeSchemaV1` validation during `safeParse`.
 */
export const dataNodeSchemaInputSchema: z.ZodType<DataNodeSchemaV1> = z
  .record(z.string(), z.unknown())
  .superRefine((raw, context) => {
    const parsed = interactiveViewStateSchemaV1Schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: 'custom',
          path: issue.path,
          message: issue.message,
        });
      }
      return;
    }
    const schemaIssue = validateInteractiveViewStateSchema(parsed.data);
    if (schemaIssue) {
      context.addIssue({ code: 'custom', message: schemaIssue });
    }
  }) as unknown as z.ZodType<DataNodeSchemaV1>;

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
      z
        .object({
          kind: z.literal('data-node'),
          nodeId: z.string().min(1),
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
  'data.replace',
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
    ownerThreadId: z.string().min(1).optional(),
    state: z
      .object({
        schema: interactiveViewStateSchemaV1Schema,
        value: interactiveViewJsonValueSchema,
      })
      .strict(),
    bindings: z.array(interactiveViewDataBindingV1Schema).max(20),
    actions: z.array(interactiveViewActionGrantV1Schema).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.actions.some((action) => action.kind === 'agent.submit') &&
      !value.ownerThreadId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ownerThreadId'],
        message: 'ownerThreadId is required when agent.submit is granted',
      });
    }
  });
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

export const interactiveViewBindingParamsSchema =
  interactiveViewResourceParamsSchema
    .extend({
      bindingId: z.string().min(1).max(128),
    })
    .strict();

export const DEFAULT_INTERACTIVE_VIEW_STATE = {
  schema: { type: 'null' as const },
  value: null,
} as const;

export const createInteractiveViewRequestSchema = z
  .object({
    rendererArtifact: z
      .string()
      .min(1)
      .max(255)
      .regex(/^(?:upload\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*\.html?$/i),
    viewKey: z.string().min(1).max(128).optional(),
    label: z.string().min(1).max(256).optional(),
    ownerThreadId: z.string().min(1).optional(),
    state: z
      .object({
        schema: interactiveViewStateSchemaV1Schema,
        value: interactiveViewJsonValueSchema,
      })
      .strict()
      .optional(),
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
  .strict()
  .superRefine((value, context) => {
    if (
      value.actions.some((action) => action.kind === 'agent.submit') &&
      !value.ownerThreadId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ownerThreadId'],
        message: 'ownerThreadId is required when agent.submit is granted',
      });
    }
  });
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

export const replaceInteractiveViewDataNodeRequestSchema = z
  .object({
    revision: z.string().min(1),
    value: interactiveViewJsonValueSchema.superRefine((value, context) => {
      const boundsIssue = validateInteractiveViewJsonBounds(value);
      if (boundsIssue) {
        context.addIssue({ code: 'custom', message: boundsIssue });
        return;
      }
      const secretIssue = validateDataNodeSecretKeys(value);
      if (secretIssue) {
        context.addIssue({ code: 'custom', message: secretIssue });
      }
    }),
  })
  .strict();
export type ReplaceInteractiveViewDataNodeRequest = z.infer<
  typeof replaceInteractiveViewDataNodeRequestSchema
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

export const replaceInteractiveViewDataNodeResponseSchema = z
  .object({
    bindingId: z.string().min(1),
    nodeId: z.string().min(1),
    snapshot: interactiveViewDataSnapshotV1Schema,
  })
  .strict();
export type ReplaceInteractiveViewDataNodeResponse = z.infer<
  typeof replaceInteractiveViewDataNodeResponseSchema
>;

export type InteractiveViewDataNodeBindingValueV1 =
  | {
      status: 'ready';
      nodeId: string;
      label: string | null;
      value: InteractiveViewJsonValue;
      schema: DataNodeSchemaV1 | null;
    }
  | {
      status: 'missing';
      nodeId: string;
      label: null;
      value: null;
      schema: null;
      message: string;
    }
  | {
      status: 'invalid';
      nodeId: string;
      label: string | null;
      value: null;
      schema: DataNodeSchemaV1 | null;
      message: string;
    };

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
          bindingId: z.string().min(1).max(128).optional(),
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
      data?: Record<string, InteractiveViewDataSnapshotV1>;
      result?: InteractiveViewJsonValue;
    }
  | {
      type: 'huabu.view.outcome';
      requestId: string;
      status: 'error' | 'conflict' | 'unauthorized';
      code: string;
      message: string;
      currentRevision?: string;
      currentValue?: InteractiveViewJsonValue;
      details?: InteractiveViewJsonValue;
    };

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
