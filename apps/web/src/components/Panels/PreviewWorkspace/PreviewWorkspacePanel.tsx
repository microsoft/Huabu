// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The preview workspace as the layout's right panel.
 *
 * `MainLayout` slides this slot open and closed itself and always renders
 * the panel expanded, so this only has to supply the collapse control. An
 * empty workspace stays empty: a Chat is created only when the user asks.
 */

import { useEffect } from 'react';

import { isEditableTarget } from '@/hooks/shortcuts/isEditableTarget';

import { PreviewWorkspace } from './PreviewWorkspace';

type PreviewWorkspacePanelProps = {
  onToggle?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
};

export function PreviewWorkspacePanel({
  onToggle,
  isFullscreen = false,
  onToggleFullscreen,
}: PreviewWorkspacePanelProps) {
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
