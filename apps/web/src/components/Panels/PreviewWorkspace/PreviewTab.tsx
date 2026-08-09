// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A single tab in a preview group's strip.
 *
 * The title is derived from the target on every render rather than copied
 * onto the tab, so a rename propagates live (§9.1 of the unified preview
 * workspace proposal).
 *
 * The tab itself is a `div` with `role="tab"`: it owns the click and key
 * handling, and the close control is a real `button` inside it. Making the
 * tab a `button` too would nest interactive elements.
 */

import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getNodeIcon } from '@/config/nodeIcons';
import useCanvasStore from '@/store/canvasStore';

import { cn } from '../../Common/cn';

import type { PreviewTab as PreviewTabModel } from '@/store/previewWorkspace/model';

type PreviewTabProps = {
  tab: PreviewTabModel;
  isActive: boolean;
  /** Ids wiring the tab to its panel for `aria-controls` / `aria-labelledby`. */
  tabElementId: string;
  panelElementId: string;
  onActivate: () => void;
  onClose: () => void;
  /** Promotes a transient tab, matching the editor's double-click gesture. */
  onPromote: () => void;
  /** Strip-level navigation; the tab owns it because it holds the focus. */
  onNavigate: (e: React.KeyboardEvent) => void;
};

export function PreviewTab({
  tab,
  isActive,
  tabElementId,
  panelElementId,
  onActivate,
  onClose,
  onPromote,
  onNavigate,
}: PreviewTabProps) {
  const { t } = useTranslation();
  const target = tab.target;
  const node = useCanvasStore((s) =>
    target.kind === 'node'
      ? s.nodes.find((n) => n.id === target.nodeId)
      : undefined,
  );

  const isNode = target.kind === 'node';
  const label =
    isNode && typeof node?.data.label === 'string' ? node.data.label : '';
  const title = isNode ? label || t('node.untitled') : t('preview.chatTab');
  const Icon = isNode ? getNodeIcon(node?.type, node?.data) : undefined;

  // Two tabs may legitimately show the same label, so the accessible name
  // carries the node type to keep screen-reader output distinguishable.
  const accessibleName = isNode
    ? `${title} (${node?.type ?? 'node'})`
    : t('preview.chatTab');

  return (
    <div
      role="tab"
      id={tabElementId}
      aria-selected={isActive}
      aria-controls={panelElementId}
      aria-label={accessibleName}
      tabIndex={isActive ? 0 : -1}
      title={title}
      data-preview-tab-id={tab.id}
      onClick={onActivate}
      onDoubleClick={onPromote}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
          return;
        }
        onNavigate(e);
      }}
      className={cn(
        'group flex max-w-48 min-w-0 shrink-0 cursor-pointer items-center gap-1.5',
        'border-edge-default border-r px-3 py-1.5 text-xs',
        'focus-visible:outline-info focus-visible:outline-1 focus-visible:-outline-offset-2',
        isActive
          ? 'bg-bg-default text-fg-default'
          : 'text-fg-muted hover:bg-hover',
        // Italic marks the reusable inspection slot, per §9.2.
        tab.transient && 'italic',
      )}
    >
      {Icon && <Icon size={13} className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <button
        type="button"
        aria-label={t('preview.closeTab', { title })}
        title={t('actions.close')}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          'hover:bg-hover flex shrink-0 items-center justify-center rounded p-0.5',
          'focus-visible:outline-info focus-visible:outline-1',
          // Kept out of the way until the tab is hovered or focused, so the
          // strip stays quiet, but never hidden from keyboards.
          !isActive && 'opacity-0 group-hover:opacity-100 focus:opacity-100',
        )}
      >
        <X size={12} />
      </button>
    </div>
  );
}
