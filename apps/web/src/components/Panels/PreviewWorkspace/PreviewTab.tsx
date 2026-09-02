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

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MessageSquare, Pin, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getNodeIcon } from '@/config/nodeIcons';
import useCanvasStore from '@/store/canvasStore';

import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';
import { Tooltip } from '../../Common/Tooltip';

import type { PreviewTab as PreviewTabModel } from '@/store/previewWorkspace/model';

type PreviewTabProps = {
  tab: PreviewTabModel;
  groupId: string;
  isActive: boolean;
  /** Ids wiring the tab to its panel for `aria-controls` / `aria-labelledby`. */
  tabElementId: string;
  panelElementId: string;
  onActivate: () => void;
  onClose: () => void;
  /** Promotes a transient tab through its explicit Pin action. */
  onPromote: () => void;
  /** Strip-level navigation; the tab owns it because it holds the focus. */
  onNavigate: (e: React.KeyboardEvent) => void;
  /** Marks which edge receives the active drag. */
  dropIndicatorEdge?: 'before' | 'after';
};

type PreviewTabPresentation = {
  title: string;
  accessibleName: string;
  tabDescription: string;
  Icon: ReturnType<typeof getNodeIcon>;
};

function usePreviewTabPresentation(
  tab: PreviewTabModel,
): PreviewTabPresentation {
  const { t } = useTranslation();
  const target = tab.target;
  const node = useCanvasStore((s) =>
    target.kind === 'node'
      ? s.nodes.find((candidate) => candidate.id === target.nodeId)
      : undefined,
  );
  const isNode = target.kind === 'node';
  const label =
    isNode && typeof node?.data.label === 'string' ? node.data.label : '';
  const title = isNode ? label || t('node.untitled') : t('preview.chatTab');
  const Icon = isNode ? getNodeIcon(node?.type, node?.data) : MessageSquare;
  const accessibleName = isNode
    ? `${title} (${node?.type ?? 'node'})`
    : t('preview.chatTab');

  return {
    title,
    accessibleName,
    tabDescription: tab.transient
      ? t('preview.transientTabHint', { title })
      : title,
    Icon,
  };
}

export function PreviewTabDragOverlay({ tab }: { tab: PreviewTabModel }) {
  const { title, Icon } = usePreviewTabPresentation(tab);

  return (
    <div
      data-testid="preview-tab-drag-overlay"
      className={cn(
        'bg-surface text-fg-default border-edge-default flex h-9 max-w-48 min-w-20 items-center gap-1.5 rounded border px-2.5 text-sm shadow-md',
        tab.transient && 'italic',
      )}
    >
      {Icon && <Icon size={14} className="shrink-0" />}
      <span className="min-w-0 truncate">{title}</span>
      <X size={13} className="ml-auto shrink-0" aria-hidden="true" />
    </div>
  );
}

export function PreviewTab({
  tab,
  groupId,
  isActive,
  tabElementId,
  panelElementId,
  onActivate,
  onClose,
  onPromote,
  onNavigate,
  dropIndicatorEdge,
}: PreviewTabProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tab.id,
    data: { type: 'preview-tab', groupId, tabId: tab.id },
  });
  const { title, accessibleName, tabDescription, Icon } =
    usePreviewTabPresentation(tab);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="tab"
      id={tabElementId}
      aria-selected={isActive}
      aria-controls={panelElementId}
      aria-label={
        tab.transient
          ? `${accessibleName}. ${t('preview.transientTabDescription')}`
          : accessibleName
      }
      tabIndex={isActive ? 0 : -1}
      data-preview-tab-id={tab.id}
      onClick={onActivate}
      onDoubleClick={() => {
        if (tab.transient) onPromote();
      }}
      onKeyDown={(e) => {
        listeners?.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
          return;
        }
        onNavigate(e);
      }}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
      }}
      className={cn(
        'group relative flex h-9 w-fit max-w-48 min-w-20 flex-none cursor-pointer items-center gap-1.5 px-2.5 text-sm',
        'border-edge-default border-r',
        'focus-visible:outline-info focus-visible:outline-1 focus-visible:-outline-offset-2',
        isActive
          ? 'bg-surface text-fg-default after:bg-info-light after:absolute after:inset-x-0 after:top-0 after:h-0.5'
          : 'text-fg-muted hover:bg-hover',
        // Italic marks the reusable inspection slot, per §9.2.
        tab.transient && 'italic',
        isDragging && 'opacity-30',
        dropIndicatorEdge === 'before' &&
          'before:bg-info before:absolute before:inset-y-1 before:left-0 before:z-10 before:w-0.5 before:rounded-full',
        dropIndicatorEdge === 'after' &&
          'after:bg-info after:absolute after:inset-y-1 after:right-0 after:z-10 after:w-0.5 after:rounded-full',
      )}
    >
      {Icon && (
        <Icon
          size={14}
          data-testid="preview-tab-icon"
          className="group-hover:text-fg-subtle shrink-0 transition-colors"
        />
      )}
      <Tooltip
        content={tabDescription}
        placement="bottom"
        wrapperClassName="inline-flex min-w-0 flex-1"
      >
        <span
          data-testid="preview-tab-title"
          className="group-hover:text-fg-subtle min-w-0 truncate transition-colors"
        >
          {title}
        </span>
      </Tooltip>
      <div
        data-testid="preview-tab-actions"
        className="ml-auto flex shrink-0 items-center gap-0"
      >
        {tab.transient && (
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            title={t('preview.keepTab')}
            aria-label={t('preview.keepTabLabel', { title })}
            tooltipPlacement="bottom"
            tooltipWrapperClassName="inline-flex"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onPromote();
            }}
            className="rounded p-0.5"
          >
            <Pin size={13} />
          </Button>
        )}
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          title={t('actions.close')}
          aria-label={t('preview.closeTab', { title })}
          tooltipPlacement="bottom"
          tooltipWrapperClassName="inline-flex"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="rounded p-0.5"
        >
          <X size={13} />
        </Button>
      </div>
    </div>
  );
}
