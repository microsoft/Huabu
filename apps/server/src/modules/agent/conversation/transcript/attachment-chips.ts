// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Attachment chips — which of a turn's attachments the user sees as a
 * chip in the composer, and the slim shape they are projected to for
 * display / persistence.
 *
 * Distinct from `render/attachments.ts`, which turns attachments into
 * the prompt text / vision parts the MODEL sees. This file is the
 * USER-facing / persistence side: pure `ChatAttachment` domain logic,
 * independent of pi-ai and of the `[SYSTEM …]` render encoding. It is
 * shared by the turn renderer (to derive the LLM sketch-raster
 * hint) and by the history builder (to rebuild a reloaded user
 * message's attachment chips), so both agree on the visible subset.
 */

import type { ChatAttachment } from '@huabu/shared';

/**
 * Pre-snapshotted sketch artifacts are server-internal: they exist so
 * the LLM can see the strokes as a vision part on the first turn, but
 * they are NOT user-visible references — the user's reference is the
 * underlying stroke nodes carried in `selectedNodeIds`.
 */
export function isSketchRasterAttachment(a: ChatAttachment): boolean {
  return (
    a.type === 'image' &&
    typeof a.url === 'string' &&
    a.url.startsWith('sketch-raster-')
  );
}

/**
 * Project an attachment to the slim persisted/display shape: drop the
 * bulky `content` body, keep identity + label + url.
 */
function projectAttachment(a: ChatAttachment): Partial<ChatAttachment> {
  return {
    type: a.type,
    source: a.source,
    ...(a.originNodeId ? { originNodeId: a.originNodeId } : {}),
    ...(a.originNodeIds && a.originNodeIds.length > 0
      ? { originNodeIds: a.originNodeIds }
      : {}),
    ...(a.url ? { url: a.url } : {}),
    ...(a.label ? { label: a.label } : {}),
    ...(a.filename ? { filename: a.filename } : {}),
  };
}

/**
 * Filter the full attachment list down to the user-visible subset the
 * UI renders as chips, dropping:
 *   (1) sketch-raster artifacts — server-internal, surfaced to the LLM
 *       only via the chat-turn hint, never as a chip;
 *   (2) selection-sourced items whose origin nodes are already carried
 *       by `selectedNodeIds`, because the UI renders one chip per
 *       selected node.
 */
export function selectUserVisibleAttachments(
  attachments: ChatAttachment[],
  selectedNodeIds: string[],
): ChatAttachment[] {
  const selectedSet = new Set(selectedNodeIds);
  return attachments.filter((a) => {
    if (isSketchRasterAttachment(a)) return false;
    if (a.source !== 'selection') return true;
    const origin = a.originNodeId ? [a.originNodeId] : (a.originNodeIds ?? []);
    if (origin.length === 0) return true;
    return !origin.every((id) => selectedSet.has(id));
  });
}

/**
 * Project the user-visible attachments to the persisted/display shape.
 * Used by the history builder so reloaded chips match what the live
 * composer showed.
 */
export function projectUserVisibleAttachments(
  attachments: ChatAttachment[],
  selectedNodeIds: string[],
): Partial<ChatAttachment>[] {
  return selectUserVisibleAttachments(attachments, selectedNodeIds).map(
    projectAttachment,
  );
}
