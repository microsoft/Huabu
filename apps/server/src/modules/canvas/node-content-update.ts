// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isLabelProtected } from '../preprocessing/label-policy.js';

import type { NodeContent } from './persistence-types.js';
import type { PutNodeContentRequest } from '@huabu/shared';

const textBearingNodeTypes = new Set([
  'note',
  'text',
  'web',
  'pdf',
  'office',
  'question',
]);

/** Shared content-owner policy for legacy PUT and recoverable body commits. */
export function resolveNodeContentUpdate(
  nodeId: string,
  input: PutNodeContentRequest,
  existing: NodeContent | null,
): NodeContent {
  const acceptsBody = textBearingNodeTypes.has(input.nodeType);
  const body = acceptsBody ? (input.content ?? existing?.content ?? '') : '';
  const wouldClobber =
    acceptsBody &&
    input.nodeType !== 'question' &&
    input.content === '' &&
    typeof existing?.content === 'string' &&
    existing.content.length > 0;
  const protectAutomaticLabel =
    input.labelSource === 'auto' &&
    isLabelProtected(existing?.['labelSource'], existing?.label);
  const result: NodeContent = {
    ...(existing ?? {}),
    nodeId,
    type: input.nodeType,
    label:
      protectAutomaticLabel || input.label === undefined
        ? (existing?.label ?? null)
        : (input.label ?? null),
    ...(input.src !== undefined
      ? { src: input.src }
      : existing?.src !== undefined
        ? { src: existing.src }
        : {}),
    content: wouldClobber && existing ? existing.content : body,
  };
  if (input.labelSource !== undefined && !protectAutomaticLabel)
    result['labelSource'] = input.labelSource;
  if (input.summary !== undefined) result['summary'] = input.summary;
  if (input.keywords !== undefined) result['keywords'] = input.keywords;
  if (input.provenance !== undefined) result['provenance'] = input.provenance;
  return result;
}
