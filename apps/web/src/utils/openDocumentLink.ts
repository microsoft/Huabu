// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isElectron } from '@/hooks/useElectron';
import { openPreviewUrl } from '@/store/previewWorkspace/actions';
import { openNodeReference } from '@/utils/activateNodeTarget';
import { parseNodeReferenceHref } from '@/utils/nodeDeepLink';
import { normalizeSafeLinkHref } from '@/utils/safeLink';

/**
 * Route document links: in-app node links activate their node, everything else
 * goes through the host's HTTP(S)-only navigation boundary.
 */
export function openDocumentLink(
  href: string,
  source?: {
    nodeId?: string;
    threadId?: string;
    /** Space that owns the document, when it is not the loaded one. */
    canvasId?: string;
  },
): void {
  const reference = parseNodeReferenceHref(href, window.location.origin);
  if (reference) {
    // Only an absolute deep link may still be useful as an ordinary URL.
    if (openNodeReference(reference, source?.canvasId)) return;
    if (reference.canvasId === undefined) return;
  }

  if (isElectron()) {
    // The workspace action validates before promoting the source or opening a tab.
    openPreviewUrl(href, source?.nodeId, source?.threadId);
    return;
  }

  const safeHref = normalizeSafeLinkHref(href);
  if (safeHref) window.open(safeHref, '_blank', 'noopener,noreferrer');
}
