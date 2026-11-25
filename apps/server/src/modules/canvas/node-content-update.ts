// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  dataNodeSchemaV1Schema,
  parseAndNormalizeDataNodeContent,
  validateDataNodeSecretKeys,
  validateInteractiveViewStateSchema,
  type DataNodeSchemaV1,
  type PutNodeContentRequest,
} from '@huabu/shared';
import { mergeNodeProperties } from '@huabu/shared/canvas-engine';

import { isLabelProtected } from '../preprocessing/label-policy.js';

import type { NodeContent } from './persistence-types.js';

export class DataNodeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataNodeValidationError';
  }
}

export function validateDataSchemaOrThrow(raw: unknown): DataNodeSchemaV1 {
  const parsed = dataNodeSchemaV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new DataNodeValidationError(
      parsed.error.issues[0]?.message ?? 'Invalid Data Node schema.',
    );
  }
  const schemaErr = validateInteractiveViewStateSchema(parsed.data);
  if (schemaErr) {
    throw new DataNodeValidationError(schemaErr);
  }
  const secretErr = validateDataNodeSecretKeys(parsed.data);
  if (secretErr) {
    throw new DataNodeValidationError(secretErr);
  }
  return parsed.data;
}

const textBearingNodeTypes = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'question',
  'data',
]);

/** Shared content-owner policy for legacy PUT and recoverable body commits. */
export function resolveNodeContentUpdate(
  nodeId: string,
  input: PutNodeContentRequest,
  existing: NodeContent | null,
): NodeContent {
  const effectiveType = existing?.type ?? input.nodeType;
  if (effectiveType !== 'data' && input.dataSchema !== undefined) {
    throw new DataNodeValidationError(
      'dataSchema is only supported on data nodes.',
    );
  }
  if (
    existing &&
    existing.type !== input.nodeType &&
    (existing.type === 'data' || input.nodeType === 'data')
  ) {
    throw new DataNodeValidationError(
      `Cannot change node "${nodeId}" type between "${existing.type}" and "${input.nodeType}".`,
    );
  }

  let dataSchema: DataNodeSchemaV1 | undefined;
  let canonicalDataBody: string | undefined;
  if (effectiveType === 'data') {
    dataSchema =
      input.dataSchema === null
        ? undefined
        : input.dataSchema !== undefined
          ? validateDataSchemaOrThrow(input.dataSchema)
          : existing?.dataSchema !== undefined
            ? validateDataSchemaOrThrow(existing.dataSchema)
            : undefined;
    const rawBody =
      input.content !== undefined ? input.content : (existing?.content ?? '{}');
    const normalized = parseAndNormalizeDataNodeContent(rawBody, dataSchema);
    if (!normalized.ok) {
      throw new DataNodeValidationError(normalized.message);
    }
    canonicalDataBody = normalized.formatted;
  }

  const acceptsBody = textBearingNodeTypes.has(effectiveType);
  const body =
    canonicalDataBody !== undefined
      ? canonicalDataBody
      : acceptsBody
        ? (input.content ?? existing?.content ?? '')
        : '';
  const wouldClobber =
    acceptsBody &&
    effectiveType !== 'question' &&
    effectiveType !== 'data' &&
    input.content === '' &&
    typeof existing?.content === 'string' &&
    existing.content.length > 0;
  const title = resolveNodeTitle(input, existing);
  const result: NodeContent = {
    ...(existing ?? {}),
    nodeId,
    type: effectiveType,
    label: title.label,
    ...(input.src !== undefined
      ? { src: input.src }
      : existing?.src !== undefined
        ? { src: existing.src }
        : {}),
    content: wouldClobber && existing ? existing.content : body,
  };
  if (effectiveType === 'data') {
    if (dataSchema !== undefined) {
      result.dataSchema = dataSchema;
    } else {
      delete result.dataSchema;
    }
  }
  if (title.labelSource !== undefined)
    result['labelSource'] = title.labelSource;
  if (input.summary !== undefined) result['summary'] = input.summary;
  if (input.keywords !== undefined) result['keywords'] = input.keywords;
  if (input.provenance !== undefined) result['provenance'] = input.provenance;
  return applyNodePropertyPatch(result, input);
}

/**
 * The title `input` leaves on a record that holds `existing`: the stored
 * one when the request names none, or names an automatic one over a title a
 * person or an agent gave.
 */
function resolveNodeTitle(
  input: Pick<PutNodeContentRequest, 'label' | 'labelSource'>,
  existing: NodeContent | null,
): {
  label: string | null;
  labelSource?: PutNodeContentRequest['labelSource'];
} {
  const protectAutomaticLabel =
    input.labelSource === 'auto' &&
    isLabelProtected(existing?.['labelSource'], existing?.label);
  return {
    label:
      protectAutomaticLabel || input.label === undefined
        ? (existing?.label ?? null)
        : (input.label ?? null),
    ...(input.labelSource !== undefined && !protectAutomaticLabel
      ? { labelSource: input.labelSource }
      : {}),
  };
}

/**
 * The request fields the content revision protects: the body (`content`,
 * `src`) and what is derived from one particular body (`summary`,
 * `keywords`, `provenance`). A request that carries any of them quotes the
 * body it was made on and is refused when the stored body has changed since.
 */
const NODE_VERSIONED_REQUEST_KEYS = [
  'content',
  'src',
  'summary',
  'keywords',
  'provenance',
  'dataSchema',
] as const satisfies readonly (keyof PutNodeContentRequest)[];

/**
 * Whether `input` carries a title that no revision protects: one a person
 * or an agent gave. It is an independent small item like a custom property
 * — last writer wins. An automatic title (`labelSource: 'auto'`) is derived
 * from a body and is checked with it.
 */
export function carriesAuthoredTitle(
  input: Pick<PutNodeContentRequest, 'label' | 'labelSource'>,
): boolean {
  return (
    input.labelSource !== 'auto' &&
    (input.label !== undefined || input.labelSource !== undefined)
  );
}

/**
 * Whether the body's revision (`expectRev`) applies to `input`: it carries
 * the body, something derived from a body, or an automatic title. A request
 * of an authored title and/or custom properties alone is never refused as
 * stale, whatever revision it quotes.
 */
export function isRevisionCheckedRequest(
  input: PutNodeContentRequest,
): boolean {
  return (
    NODE_VERSIONED_REQUEST_KEYS.some((key) => input[key] !== undefined) ||
    (input.labelSource === 'auto' && input.label !== undefined)
  );
}

/**
 * `record` (the stored record as it is now) with the part of `input` that no
 * revision protects applied: an authored title and the custom-property
 * patch. Used for a request whose body was refused as stale, so a rename or
 * a property edit that travelled with it is not lost with it.
 */
export function applyNodeUnversionedPatch(
  record: NodeContent,
  input: PutNodeContentRequest,
): NodeContent {
  const result = applyNodePropertyPatch(record, input);
  if (!carriesAuthoredTitle(input)) return result;
  const title = resolveNodeTitle(input, record);
  result.label = title.label;
  if (title.labelSource !== undefined)
    result['labelSource'] = title.labelSource;
  return result;
}

/**
 * `record` (the stored record as it is now) with the custom-property patch
 * of `input` applied. Keywise: `null` deletes one key, keys the patch omits
 * are kept. The display order is replaced as a whole. No revision is
 * involved: the patch is applied to whatever the record holds.
 */
export function applyNodePropertyPatch(
  record: NodeContent,
  input: Pick<PutNodeContentRequest, 'properties' | 'propertyDisplayKeys'>,
): NodeContent {
  const result: NodeContent = { ...record };
  if (input.properties !== undefined)
    result.properties = mergeNodeProperties(
      record.properties,
      input.properties,
    );
  if (input.propertyDisplayKeys !== undefined)
    result.propertyDisplayKeys = input.propertyDisplayKeys;
  return result;
}
