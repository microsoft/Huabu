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
import { Globe, MessageCircle, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CANVAS_NODE_TYPES, OFFICE_FORMATS } from '@huabu/shared';

import { getNodeIcon } from '@/config/nodeIcons';
import useCanvasStore from '@/store/canvasStore';
import {
  getConversationTitle,
  useConversationTitleStore,
} from '@/store/conversationTitleStore';

import { Button } from '../../Common/Button';
import { cn } from '../../Common/cn';
import { DropdownMenu, DropdownMenuItem } from '../../Common/DropdownMenu';
import { Tooltip } from '../../Common/Tooltip';
import {
  buildOfficeFilterKey,
  getFilterKeyLabelKey,
} from '../CanvasLayerPanel/layerFilterKey';
import {
  AcpConnectionDot,
  useAcpConnectionDescription,
  type AcpConnectionInfo,
} from '../ChatPanel/AcpConnectionBadge';

import type { PreviewTab as PreviewTabModel } from '@/store/previewWorkspace/model';

type PreviewTabProps = {
  chatConnection?: AcpConnectionInfo;
  tab: PreviewTabModel;
  groupId: string;
  isActive: boolean;
  /** Ids wiring the tab to its panel for `aria-controls` / `aria-labelledby`. */
  tabElementId: string;
  panelElementId: string;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers?: () => void;
  onCloseToRight?: () => void;
  onCloseGroup?: () => void;
  /** Promotes a transient tab through its menu action or double-click. */
  onPromote: () => void;
  onRename?: () => void;
  onTitleEditorHostChange?: (element: HTMLSpanElement | null) => void;
  /** Strip-level navigation; the tab owns it because it holds the focus. */
  onNavigate: (e: React.KeyboardEvent) => void;
  /** Marks which edge receives the active drag. */
  dropIndicatorEdge?: 'before' | 'after';
};

type PreviewTabPresentation = {
  title: string;
  accessibleName: string;
  tabDescription: string;
  typeLabel: string;
  Icon: ReturnType<typeof getNodeIcon>;
  canRename: boolean;
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
  const chatTitle = useConversationTitleStore((state) => {
    if (target.kind !== 'chat') return undefined;
    return getConversationTitle(target.canvasId, target.threadId, state).title;
  });
  const label =
    isNode && typeof node?.data.label === 'string' ? node.data.label : '';
  const title = isNode
    ? label || t('node.untitled')
    : target.kind === 'url'
      ? new URL(target.url).host
      : chatTitle || t('chat.newConversation');
  const Icon = isNode
    ? getNodeIcon(node?.type, node?.data)
    : target.kind === 'url'
      ? Globe
      : MessageCircle;
  const accessibleName = isNode
    ? `${title} (${node?.type ?? 'node'})`
    : target.kind === 'url'
      ? target.url
      : title;
  const nodeType = CANVAS_NODE_TYPES.find((type) => type === node?.type);
  const officeFormat = OFFICE_FORMATS.find(
    (format) => format === node?.data.format,
  );
  const typeLabel =
    target.kind === 'chat'
      ? t('preview.chatTab')
      : target.kind === 'url'
        ? t('layers.filterLabels.web')
        : nodeType
          ? t(
              getFilterKeyLabelKey(
                nodeType === 'office' && officeFormat
                  ? buildOfficeFilterKey(officeFormat)
                  : nodeType,
              ),
            )
          : t('preview.nodeUnavailable');

  return {
    title,
    accessibleName,
    tabDescription: target.kind === 'url' ? target.url : title,
    typeLabel,
    Icon,
    canRename: target.kind === 'chat' || !!node,
  };
}

export function PreviewTabDragOverlay({ tab }: { tab: PreviewTabModel }) {
  const { title, Icon } = usePreviewTabPresentation(tab);

  return (
    <div
      data-testid="preview-tab-drag-overlay"
      className={cn(
        'bg-bg-default text-fg-default flex h-7 max-w-80 min-w-20 items-center gap-1.5 rounded-lg px-2 text-sm shadow-md',
        tab.transient && 'italic',
      )}
    >
      {Icon && <Icon size={14} className="shrink-0" />}
      <span className="max-w-full min-w-0 shrink truncate">{title}</span>
      <X size={13} className="ml-auto shrink-0" aria-hidden="true" />
    </div>
  );
}

export function PreviewTab({
  chatConnection,
  tab,
  groupId,
  isActive,
  tabElementId,
  panelElementId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseGroup,
  onPromote,
  onRename,
  onTitleEditorHostChange,
  onNavigate,
  dropIndicatorEdge,
}: PreviewTabProps) {
  const { t } = useTranslation();
  const connectionDescription = useAcpConnectionDescription(chatConnection);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameLabel = t(
    tab.target.kind === 'chat' ? 'chat.renameTitle' : 'node.rename',
  );
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
  const { title, accessibleName, tabDescription, typeLabel, Icon, canRename } =
    usePreviewTabPresentation(tab);
  const canRequestRename = !!onRename && canRename;

  return (
    <>
      <Tooltip
        content={
          <div className="max-w-72 space-y-1 py-0.5 wrap-anywhere">
            <div
              data-testid="preview-tooltip-title"
              className="text-[13px] leading-snug font-semibold"
            >
              {tabDescription}
            </div>
            <div
              data-testid="preview-tooltip-meta"
              className="flex flex-wrap items-center gap-x-1.5 text-[11px] leading-relaxed opacity-80"
            >
              <span>{typeLabel}</span>
              {connectionDescription && (
                <>
                  <span
                    aria-hidden
                    className="h-2.5 border-l border-current opacity-40"
                  />
                  <span>{connectionDescription}</span>
                </>
              )}
            </div>
            {tab.transient && (
              <div
                data-testid="preview-tooltip-hint"
                className="pt-1 text-[11px] leading-relaxed opacity-70"
              >
                {t('preview.transientTabDescription')}
              </div>
            )}
          </div>
        }
        contentClassName={menuOpen ? 'hidden' : undefined}
        placement="bottom"
        wrapperClassName={cn(
          'preview-tab-slot',
          isActive && 'preview-tab-slot-active',
        )}
      >
        <DropdownMenu
          floating
          placement="bottom-start"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          triggerWrapperClassName="flex min-w-0 flex-1"
          onOpenAutoFocus={() =>
            menuRef.current
              ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
              ?.focus()
          }
          trigger={
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
              aria-haspopup="menu"
              aria-keyshortcuts={canRequestRename ? 'F2' : undefined}
              onContextMenu={(event) => {
                if (isDragging || event.target instanceof HTMLInputElement)
                  return;
                event.preventDefault();
                event.stopPropagation();
                setMenuOpen(true);
              }}
              onClick={(event) => {
                event.preventDefault();
                onActivate();
              }}
              onDoubleClick={() => {
                if (tab.transient) onPromote();
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (isDragging) return;
                if (canRequestRename && e.key === 'F2') {
                  e.preventDefault();
                  e.stopPropagation();
                  onRename?.();
                  return;
                }
                if (
                  e.key === 'ContextMenu' ||
                  (e.shiftKey && e.key === 'F10')
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuOpen(true);
                  return;
                }
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
                'group relative flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-sm',
                'focus-visible:outline-info focus-visible:outline-1 focus-visible:-outline-offset-2',
                isActive
                  ? 'bg-bg-default text-fg-default'
                  : 'text-fg-muted hover:bg-hover hover:text-fg-default',
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
                <span className="relative inline-flex shrink-0">
                  <Icon size={14} aria-hidden data-testid="preview-tab-icon" />
                  {chatConnection && (
                    <AcpConnectionDot
                      status={chatConnection.status}
                      className="ring-bg-default absolute -right-0.5 -bottom-0.5 ring-2"
                    />
                  )}
                </span>
              )}
              <span
                data-testid="preview-tab-title"
                className="preview-tab-title min-w-0 flex-1 truncate"
              >
                {title}
              </span>
              <span
                ref={onTitleEditorHostChange}
                data-preview-title-editor-tab-id={tab.id}
                className="preview-tab-editor min-w-0 flex-1 empty:hidden"
              />
              <div
                data-testid="preview-tab-actions"
                className="preview-tab-actions ml-auto flex shrink-0 items-center gap-0"
              >
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
          }
        >
          <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            aria-label={title}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setMenuOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setMenuOpen(false);
                document
                  .getElementById(tabElementId)
                  ?.focus({ preventScroll: true });
                return;
              }
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
                return;
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              );
              const index = items.findIndex(
                (item) => item === document.activeElement,
              );
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        items.length) %
                      items.length;
              items[next]?.focus();
            }}
          >
            {canRequestRename && (
              <DropdownMenuItem
                shortcut="F2"
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  onRename?.();
                }}
              >
                {renameLabel}
              </DropdownMenuItem>
            )}
            {tab.transient && (
              <DropdownMenuItem
                onClick={() => {
                  setMenuOpen(false);
                  onPromote();
                  document
                    .getElementById(tabElementId)
                    ?.focus({ preventScroll: true });
                }}
              >
                {t('preview.keepTab')}
              </DropdownMenuItem>
            )}
            {(canRequestRename || tab.transient) && (
              <div className="border-edge-default my-1 border-t" />
            )}
            <DropdownMenuItem
              onClick={() => {
                setMenuOpen(false);
                onClose();
              }}
            >
              {t('actions.close')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!onCloseOthers}
              onClick={() => {
                setMenuOpen(false);
                onCloseOthers?.();
              }}
            >
              {t('preview.closeOtherTabs')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!onCloseToRight}
              onClick={() => {
                setMenuOpen(false);
                onCloseToRight?.();
              }}
            >
              {t('preview.closeTabsToRight')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!onCloseGroup}
              onClick={() => {
                setMenuOpen(false);
                onCloseGroup?.();
              }}
            >
              {t('preview.closeGroupTabs')}
            </DropdownMenuItem>
          </div>
        </DropdownMenu>
      </Tooltip>
    </>
  );
}
