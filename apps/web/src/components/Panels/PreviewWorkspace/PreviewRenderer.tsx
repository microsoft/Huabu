// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Resolves a preview target to a rendered surface.
 *
 * The target is resolved here, at render time, rather than copying mutable
 * node data onto the tab — so an edit or a type change is reflected without
 * the workspace holding a stale copy (§7 of the proposal).
 */

import { useTranslation } from 'react-i18next';

import useCanvasStore from '@/store/canvasStore';

import { NodePreviewContent } from '../../Nodes/NodePreviewContent';
import { ChatPanel } from '../ChatPanel';

import type { PreviewTarget } from '@/store/previewWorkspace/model';

export function PreviewRenderer({ target }: { target: PreviewTarget }) {
  const { t } = useTranslation();
  const node = useCanvasStore((s) =>
    target.kind === 'node'
      ? s.nodes.find((n) => n.id === target.nodeId)
      : undefined,
  );

  if (target.kind === 'chat') {
    // `ChatPanel` still resolves its session from the store-wide current
    // thread (L1), so a second Chat tab would mirror the first. Tabs are
    // addressed correctly here already; the panel catches up when L1 lands.
    return <ChatPanel />;
  }

  if (!node) {
    // A tab can outlive its node when deletion arrives from elsewhere;
    // validation removes it, and this covers the frame in between.
    return (
      <div className="text-fg-subtle flex h-full items-center justify-center text-sm">
        {t('preview.nodeUnavailable')}
      </div>
    );
  }

  return (
    <NodePreviewContent
      id={node.id}
      type={node.type ?? 'text'}
      data={node.data as Record<string, unknown>}
    />
  );
}
