/**
 * Pure preprocessing predicates used inside the canvas-engine command
 * handlers. The web-side counterpart in `apps/web/src/handler/canvasCommand/preprocess.ts`
 * still owns the impure trigger function (`preprocessNodeIfNeeded`) which
 * makes API calls — only the pure node-shape predicates live here so they
 * can run in the headless executor.
 */

import type { Node } from '@xyflow/react';

/**
 * Node types that have any kind of preprocessing behavior (ingestion,
 * label resolution, or both).
 */
const PREPROCESS_TYPES = new Set<string>([
  'note',
  'text',
  'web',
  'pdf',
  'image',
  'frame',
]);

/** Returns true when this node type has any preprocessing behavior. */
export function needsPreprocessing(nodeType: string): boolean {
  return PREPROCESS_TYPES.has(nodeType);
}

function getStringDataField(node: Node, field: string): string {
  const data = node.data as Record<string, unknown> | undefined;
  const value = data?.[field];
  return typeof value === 'string' ? value : '';
}

/**
 * Decide whether a node update should trigger preprocessing.
 *
 * Returns true when a watched data field has changed for this node type.
 * Frame nodes always return false here — frame label re-resolution is
 * triggered by child label changes (see command handlers).
 */
export function shouldPreprocessOnUpdate(
  prevNode: Node,
  nextNode: Node,
): boolean {
  const nextType = nextNode.type ?? '';
  if (!needsPreprocessing(nextType)) return false;
  if ((prevNode.type ?? '') !== nextType) return true;

  const labelChanged =
    getStringDataField(prevNode, 'label') !==
    getStringDataField(nextNode, 'label');

  if (nextType === 'note' || nextType === 'text') {
    return (
      getStringDataField(prevNode, 'content') !==
        getStringDataField(nextNode, 'content') || labelChanged
    );
  }

  if (nextType === 'web' || nextType === 'pdf' || nextType === 'image') {
    return (
      getStringDataField(prevNode, 'src') !==
        getStringDataField(nextNode, 'src') || labelChanged
    );
  }

  // frame: label changes in children trigger preprocessing via
  // the preprocessNodes array in command handlers, not here.
  return false;
}
