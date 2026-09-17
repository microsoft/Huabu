// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isElectron } from '@/hooks/useElectron';
import { openPreviewUrl } from '@/store/previewWorkspace/actions';
import { normalizeSafeLinkHref } from '@/utils/safeLink';

/** Route document links through the host's HTTP(S)-only navigation boundary. */
export function openDocumentLink(
  href: string,
  source?: { nodeId?: string; threadId?: string },
): void {
  if (isElectron()) {
    // The workspace action validates before promoting the source or opening a tab.
    openPreviewUrl(href, source?.nodeId, source?.threadId);
    return;
  }

  const safeHref = normalizeSafeLinkHref(href);
  if (safeHref) window.open(safeHref, '_blank', 'noopener,noreferrer');
}
