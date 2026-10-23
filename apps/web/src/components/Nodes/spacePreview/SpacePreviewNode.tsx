// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore } from '@xyflow/react';
import { ArrowUpRight, Pencil, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { SPACE_SHORTCUT_SIZE } from '@huabu/shared/canvas-engine';

import { ApiError } from '@/api/_client';
import { renameSpace } from '@/api/spaceCard';
import { Button } from '@/components/Common/Button';
import { DropdownMenuItem } from '@/components/Common/DropdownMenu';
import { TextInput } from '@/components/Common/TextInput';
import { Tooltip } from '@/components/Common/Tooltip';
import { nodeLayoutBorderInset } from '@/components/Nodes/design/nodeBoundary';
import { CONVERSATION_CARD_SPACING } from '@/components/Nodes/design/nodeSpacing';
import { SPACE_CARD_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper';
import { getNodeIcon } from '@/config/nodeIcons';
import { useTextAutoSize } from '@/hooks/useTextAutoSize';
import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import {
  FONT_FAMILY_CSS,
  getQuestionFontOpts,
} from '@/utils/node/nodeFontConfig';
import { buildNodeDeepLink } from '@/utils/nodeDeepLink';

import { SpaceAgentActivity } from './SpaceAgentActivity';
import {
  OPEN_SPACE_SHORTCUT_EVENT,
  RENAME_SPACE_SHORTCUT_EVENT,
  type OpenSpaceShortcutDetail,
} from './spaceShortcutEvents';
import {
  useSpaceCardActivity,
  refreshSpaceCardActivity,
} from './useSpaceCardActivity';
import { useSpaceShortcutTarget } from './useSpaceShortcutTarget';
import { NodeActivityTime } from '../shared/NodeActivityTime';

import type { SpacePreviewNodeData } from '@/components/Nodes/types';
import type { SpaceCardAgent } from '@huabu/shared';
import type { Node, NodeProps } from '@xyflow/react';

export type SpacePreviewNodeType = Node<SpacePreviewNodeData, 'spacePreview'>;
const typography = SPACE_CARD_TYPOGRAPHY.title;
const SpaceIcon = getNodeIcon('spacePreview');
const fontOpts = getQuestionFontOpts();

export const SpacePreviewNode = memo(
  ({ id, data, selected }: NodeProps<SpacePreviewNodeType>) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const target = useSpaceShortcutTarget(data.targetCanvasId);
    const snapshot = useSpaceCardActivity(
      data.targetCanvasId,
      target.status === 'ready',
    );
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const [renameError, setRenameError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const savingRef = useRef(false);
    const cancelled = useRef(false);
    const selectedOnPointerDown = useRef(false);
    const expectedTitle = useRef<string | null>(null);
    const canvasId = useCanvasStore((state) => state.canvasId);
    const workspaceId = useWorkspaceStore((state) => state.workspaceId);
    const worldId = useWorkspaceStore((state) => state.worldCanvasId);
    const isChildEntry = useWorkspaceStore(
      (state) =>
        state.spaceSummaries[data.targetCanvasId]?.parentSpaceId === canvasId &&
        state.spaceSummaries[data.targetCanvasId]?.parentEntryNodeId === id,
    );
    const liveWidth = useStore(
      (state) => state.nodeLookup.get(id)?.style?.width,
    );
    // Reuse proportional resize mechanics; the clamped Space title keeps DOM-owned height.
    const sizing = useTextAutoSize({
      nodeId: id,
      text: target.title,
      width:
        typeof liveWidth === 'number'
          ? liveWidth
          : SPACE_SHORTCUT_SIZE.defaultWidth,
      baseFontSize: typography.size,
      paddingX: CONVERSATION_CARD_SPACING.padding,
      paddingY: CONVERSATION_CARD_SPACING.padding,
      fontOpts,
      fontSizing: 'proportional',
    });
    const scale = sizing.effectiveFontSize / typography.size;
    const targetStatus =
      snapshot?.status === 'missing' ? 'missing' : target.status;
    const canOpen = targetStatus === 'ready';
    const canRename =
      canOpen && !data.locked && data.targetCanvasId !== worldId;
    const startRename = useCallback(() => {
      if (!canRename || savingRef.current) return;
      const title =
        useWorkspaceStore.getState().spaceTitles[data.targetCanvasId] ?? null;
      expectedTitle.current = title;
      cancelled.current = false;
      setDraft(title ?? '');
      setRenameError(null);
      setEditing(true);
    }, [canRename, data.targetCanvasId]);
    useEffect(() => {
      if (editing) {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }, [editing]);
    const commitRename = async () => {
      if (cancelled.current || savingRef.current) return;
      const title = draft.trim();
      if (!title) {
        setRenameError(t('spacePreview.nameRequired'));
        return;
      }
      if (title === expectedTitle.current) {
        cancelled.current = true;
        setEditing(false);
        return;
      }
      savingRef.current = true;
      setSaving(true);
      setRenameError(null);
      try {
        const result = await renameSpace(data.targetCanvasId, {
          title,
          expectedTitle: expectedTitle.current,
        });
        const current = useWorkspaceStore.getState();
        if (current.workspaceId !== workspaceId || current.isSyncing) return;
        current.setSpaceTitle(data.targetCanvasId, result.title);
        void current.refreshSpaceTitles([data.targetCanvasId]);
        refreshSpaceCardActivity();
        cancelled.current = true;
        setEditing(false);
      } catch (error) {
        setRenameError(
          t(
            error instanceof ApiError && error.code === 'CANVAS_TITLE_CONFLICT'
              ? 'spacePreview.nameConflict'
              : error instanceof ApiError &&
                  error.code === 'SPACE_TITLE_CHANGED'
                ? 'spacePreview.nameChanged'
                : 'spacePreview.renameFailed',
          ),
        );
        refreshSpaceCardActivity();
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    };
    const openTarget = useCallback(() => {
      if (canOpen && !editing) {
        const path = `/canvas/${encodeURIComponent(data.targetCanvasId)}`;
        if (isChildEntry) navigate(path);
        else
          navigate(path, { state: { returnToSpace: canvasId, workspaceId } });
      }
    }, [
      canOpen,
      editing,
      data.targetCanvasId,
      navigate,
      isChildEntry,
      canvasId,
      workspaceId,
    ]);
    const openConversation = (agent: SpaceCardAgent) => {
      if (!canOpen || editing) return;
      const url = new URL(
        buildNodeDeepLink(
          window.location.origin,
          data.targetCanvasId,
          agent.nodeId,
        ),
      );
      navigate(`${url.pathname}${url.search}`, {
        state: isChildEntry
          ? undefined
          : { returnToSpace: canvasId, workspaceId },
      });
    };
    useEffect(() => {
      if (!selected) return;
      const open = (event: Event) => {
        if (
          (event as CustomEvent<OpenSpaceShortcutDetail>).detail?.nodeId === id
        )
          openTarget();
      };
      window.addEventListener(OPEN_SPACE_SHORTCUT_EVENT, open);
      const rename = (event: Event) => {
        if (
          (event as CustomEvent<OpenSpaceShortcutDetail>).detail?.nodeId === id
        )
          startRename();
      };
      window.addEventListener(RENAME_SPACE_SHORTCUT_EVENT, rename);
      return () => {
        window.removeEventListener(OPEN_SPACE_SHORTCUT_EVENT, open);
        window.removeEventListener(RENAME_SPACE_SHORTCUT_EVENT, rename);
      };
    }, [id, selected, openTarget, startRename]);
    const failed =
      targetStatus === 'missing' ||
      targetStatus === 'error' ||
      target.error !== null;
    const statusText =
      targetStatus === 'loading'
        ? t('spacePreview.loadingTarget')
        : targetStatus === 'missing'
          ? t('spacePreview.missingTarget')
          : targetStatus === 'error' || target.error !== null
            ? (target.error ?? t('spacePreview.targetsUnavailable'))
            : t(
                isChildEntry
                  ? 'spaceHierarchy.childEntry'
                  : 'spacePreview.shortcut',
              );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="spacePreview"
        selected={selected}
        minWidth={SPACE_SHORTCUT_SIZE.minWidth * scale}
        onResizeStart={sizing.handleResizeStart}
        onResize={sizing.handleResize}
        onResizeEnd={sizing.handleResizeEnd}
        resizeEndClearHeight
        onDoubleClick={openTarget}
        farLabel={{ title: target.title }}
        actions={
          <Button
            variant="ghost"
            iconOnly
            title={t('spacePreview.openSpace')}
            disabled={!canOpen}
            onClick={openTarget}
          >
            <ArrowUpRight />
          </Button>
        }
        overflow={
          <>
            <DropdownMenuItem
              icon={<Pencil />}
              aria-label={t('spacePreview.rename')}
              disabled={!canRename}
              onClick={startRename}
            >
              {t('spacePreview.rename')}
            </DropdownMenuItem>
            {targetStatus === 'error' ||
            targetStatus === 'missing' ||
            target.error !== null ||
            snapshot?.status === 'error' ? (
              <DropdownMenuItem
                icon={<RefreshCw />}
                aria-label={t('spacePreview.retry')}
                onClick={() => {
                  target.retry();
                  refreshSpaceCardActivity();
                }}
              >
                {t('spacePreview.retry')}
              </DropdownMenuItem>
            ) : null}
          </>
        }
      >
        <div
          className="text-fg-default flex items-start"
          data-space-shortcut={data.targetCanvasId}
          data-target-status={targetStatus}
          style={{
            width:
              typeof liveWidth === 'number'
                ? (liveWidth - 2 * nodeLayoutBorderInset('spacePreview')) /
                  scale
                : undefined,
            zoom: scale,
            padding: CONVERSATION_CARD_SPACING.padding,
            // Match Question's outer-edge inset despite the layout border.
            paddingInline: Math.max(
              0,
              CONVERSATION_CARD_SPACING.padding -
                nodeLayoutBorderInset('spacePreview') / scale,
            ),
            fontFamily: FONT_FAMILY_CSS.default,
            fontSize: typography.size,
            fontWeight: typography.weight,
            lineHeight: typography.lineHeight,
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-start gap-2">
              <span
                className="text-fg-muted inline-flex h-[1lh] shrink-0 items-center justify-center"
                style={{ width: CONVERSATION_CARD_SPACING.iconSlotWidth }}
                data-space-type-icon
                aria-hidden
              >
                <SpaceIcon
                  size={CONVERSATION_CARD_SPACING.spaceIconSize}
                  style={{
                    width: CONVERSATION_CARD_SPACING.spaceIconSize,
                    height: CONVERSATION_CARD_SPACING.spaceIconSize,
                  }}
                />
              </span>
              <div
                className="flex min-w-0 flex-1 items-start gap-1"
                onPointerDownCapture={() => {
                  selectedOnPointerDown.current = !!selected;
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                {editing ? (
                  <TextInput
                    ref={inputRef}
                    value={draft}
                    readOnly={saving}
                    aria-label={t('spacePreview.rename')}
                    aria-invalid={!!renameError}
                    className="nodrag nopan w-full min-w-0 p-0"
                    style={{ font: 'inherit', lineHeight: 'inherit' }}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setRenameError(null);
                    }}
                    onBlur={() => void commitRename()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (
                        event.nativeEvent.isComposing ||
                        event.nativeEvent.keyCode === 229
                      )
                        return;
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void commitRename();
                      }
                      if (event.key === 'Escape' && !savingRef.current) {
                        event.preventDefault();
                        cancelled.current = true;
                        setEditing(false);
                        setRenameError(null);
                      }
                    }}
                  />
                ) : selected && canRename ? (
                  <Button
                    variant="ghost"
                    className="nodrag nopan text-fg-default h-auto min-w-0 justify-start p-0 text-left"
                    tooltipWrapperClassName="min-w-0 max-w-full"
                    style={{ font: 'inherit', lineHeight: 'inherit' }}
                    title={t('spacePreview.rename')}
                    onClick={(event) => {
                      if (selectedOnPointerDown.current || event.detail === 0)
                        startRename();
                    }}
                  >
                    <span
                      className="line-clamp-2 min-w-0 wrap-anywhere"
                      title={target.title}
                    >
                      {target.title}
                    </span>
                  </Button>
                ) : (
                  <span
                    className="line-clamp-2 min-w-0 wrap-anywhere"
                    title={target.title}
                  >
                    {target.title}
                  </span>
                )}
                {!isChildEntry &&
                canvasId !== worldId &&
                targetStatus === 'ready' ? (
                  <Tooltip
                    content={t('spacePreview.shortcutLabel')}
                    wrapperClassName="inline-flex h-[1lh] shrink-0 items-center"
                  >
                    <ArrowUpRight
                      size="1em"
                      style={{ width: '1em', height: '1em' }}
                      aria-label={t('spacePreview.shortcutLabel')}
                    />
                  </Tooltip>
                ) : null}
              </div>
            </div>
            {renameError ? (
              <span
                role="alert"
                className="text-danger"
                style={{ fontSize: SPACE_CARD_TYPOGRAPHY.metadata.size }}
              >
                {renameError}
              </span>
            ) : null}
            {targetStatus === 'ready' ? (
              <div
                className="flex items-center gap-2"
                style={{ height: CONVERSATION_CARD_SPACING.footerHeight }}
              >
                <SpaceAgentActivity
                  onOpen={openConversation}
                  errorDetail={target.error ?? undefined}
                  activity={
                    snapshot?.status === 'ready' ? snapshot.activity : undefined
                  }
                  failed={
                    snapshot?.status === 'error' ||
                    snapshot?.status === 'missing'
                  }
                />
                <NodeActivityTime
                  updatedAt={
                    snapshot?.status === 'ready'
                      ? snapshot.updatedAt
                      : target.updatedAt
                  }
                />
              </div>
            ) : null}
            {targetStatus !== 'ready' ||
            (target.error !== null && snapshot?.status !== 'error') ? (
              <span
                className={failed ? 'text-warning' : 'text-fg-muted'}
                style={{
                  fontSize: SPACE_CARD_TYPOGRAPHY.metadata.size,
                  lineHeight: SPACE_CARD_TYPOGRAPHY.metadata.lineHeight,
                  fontWeight: 400,
                }}
                role="status"
              >
                {statusText}
              </span>
            ) : null}
          </div>
        </div>
      </NodeWrapper>
    );
  },
);

SpacePreviewNode.displayName = 'SpacePreviewNode';
