// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The preview workspace as the layout's right panel.
 *
 * `MainLayout` slides this slot open and closed itself and always renders
 * the panel expanded, so this only has to supply the collapse control and
 * the lazy first tab.
 */

import { useEffect, useRef } from 'react';

import { createId } from '@huabu/shared';

import { isEditableTarget } from '@/hooks/shortcuts/isEditableTarget';
import useCanvasStore from '@/store/canvasStore';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { PreviewWorkspace } from './PreviewWorkspace';

type PreviewWorkspacePanelProps = {
  onToggle?: () => void;
  isHostCollapsed?: boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
};

export function PreviewWorkspacePanel({
  onToggle,
  isHostCollapsed = false,
  isFullscreen = false,
  onToggleFullscreen,
}: PreviewWorkspacePanelProps) {
  const canvasId = useCanvasStore((s) => s.canvasId);
  const isEmpty = usePreviewWorkspaceStore(
    (s) => Object.keys(s.workspace.tabs).length === 0,
  );
  const openPreviewTarget = usePreviewWorkspaceStore(
    (s) => s.openPreviewTarget,
  );
  // The ref guards the duplicate effect setup in StrictMode. It resets after
  // a tab exists, allowing a later empty workspace to seed when reopened.
  const seededEmptyWorkspace = useRef(false);

  // §8: opening an empty workspace lazily creates one unbound Chat, so the
  // panel is never a blank rectangle. Merely loading a Canvas does not,
  // which is why this lives here rather than in the store's load path.
  useEffect(() => {
    if (!isEmpty) {
      seededEmptyWorkspace.current = false;
      return;
    }
    if (!canvasId || isHostCollapsed || seededEmptyWorkspace.current) return;
    seededEmptyWorkspace.current = true;
    openPreviewTarget({
      kind: 'chat',
      canvasId,
      threadId: createId('thread'),
    });
  }, [canvasId, isEmpty, isHostCollapsed, openPreviewTarget]);

  useEffect(() => {
    if (!isFullscreen || !onToggleFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (isEditableTarget(target)) return;
      if (
        target instanceof Element &&
        target.closest('[role="dialog"], [role="menu"], [role="combobox"]')
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onToggleFullscreen();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isFullscreen, onToggleFullscreen]);

  return (
    <div className="bg-surface h-full shadow-[-1px_0_0_var(--edge-default)]">
      <PreviewWorkspace
        onCollapse={onToggle}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
    </div>
  );
}
