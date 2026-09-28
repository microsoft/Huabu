// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore } from '@xyflow/react';
import { AlertTriangle, ArrowUpRight, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { SPACE_SHORTCUT_SIZE } from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { Tooltip } from '@/components/Common/Tooltip';
import { NODE_BORDER_WIDTH } from '@/components/Nodes/design/nodeBoundary';
import { NODE_CONTENT_SPACING } from '@/components/Nodes/design/nodeSpacing';
import { NODE_TYPOGRAPHY } from '@/components/Nodes/design/nodeTypography';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper';
import { getNodeIcon } from '@/config/nodeIcons';
import useCanvasStore from '@/store/canvasStore';
import { FONT_FAMILY_CSS } from '@/utils/node/nodeFontConfig';
import { measureTextContent } from '@/utils/node/textMeasure';

import {
  OPEN_SPACE_SHORTCUT_EVENT,
  type OpenSpaceShortcutDetail,
} from './spaceShortcutEvents';
import { SpaceShortcutSummary } from './SpaceShortcutSummary';
import { useSpaceShortcutTarget } from './useSpaceShortcutTarget';

import type { SpacePreviewNodeData } from '@/components/Nodes/types';
import type { Node, NodeProps } from '@xyflow/react';

export type SpacePreviewNodeType = Node<SpacePreviewNodeData, 'spacePreview'>;
const SpaceIcon = getNodeIcon('spacePreview');
const typography = NODE_TYPOGRAPHY.cardTitle;
const chromeWidth =
  2 * (NODE_BORDER_WIDTH + NODE_CONTENT_SPACING.padding) +
  typography.size +
  NODE_CONTENT_SPACING.imageTextGap;

export const SpacePreviewNode = memo(
  ({ id, data, selected }: NodeProps<SpacePreviewNodeType>) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const target = useSpaceShortcutTarget(data.targetCanvasId);
    const widthMode = data.widthMode ?? 'fixed';
    const automaticWidth = useMemo(() => {
      const measured = measureTextContent(target.title, {
        fontFamily: FONT_FAMILY_CSS.default,
        fontWeight: String(typography.weight),
        fontStyle: 'normal',
        lineHeight: typography.lineHeight,
        fontSize: typography.size,
        maxWidth: 100_000,
      });
      return Math.min(
        SPACE_SHORTCUT_SIZE.autoMaxWidth,
        Math.max(SPACE_SHORTCUT_SIZE.minWidth, measured.width + chromeWidth),
      );
    }, [target.title]);
    const liveWidth = useStore(
      (state) => state.nodeLookup.get(id)?.style?.width,
    );
    const resizing = useStore((state) => !!state.nodeLookup.get(id)?.resizing);
    useLayoutEffect(() => {
      if (widthMode !== 'auto' || resizing) return;
      const state = useCanvasStore.getState();
      const node = state.nodes.find((entry) => entry.id === id);
      if (!node || node.resizing || node.style?.width === automaticWidth)
        return;
      // Derived width is a renderer measurement, not a user edit or an undo step.
      state._setStateNoAutosave({
        nodes: state.nodes.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                style: { ...entry.style, width: automaticWidth },
                measured: { ...entry.measured, width: automaticWidth },
              }
            : entry,
        ),
      });
    }, [id, automaticWidth, widthMode, liveWidth, resizing]);
    const canOpen = target.status === 'ready';
    const openTarget = useCallback(() => {
      if (canOpen)
        navigate(`/canvas/${encodeURIComponent(data.targetCanvasId)}`);
    }, [canOpen, data.targetCanvasId, navigate]);
    useEffect(() => {
      if (!selected) return;
      const open = (event: Event) => {
        if (
          (event as CustomEvent<OpenSpaceShortcutDetail>).detail?.nodeId === id
        )
          openTarget();
      };
      window.addEventListener(OPEN_SPACE_SHORTCUT_EVENT, open);
      return () => window.removeEventListener(OPEN_SPACE_SHORTCUT_EVENT, open);
    }, [id, selected, openTarget]);
    const failed =
      target.status === 'missing' ||
      target.status === 'error' ||
      target.error !== null;
    const statusText =
      target.status === 'loading'
        ? t('spacePreview.loadingTarget')
        : target.status === 'missing'
          ? t('spacePreview.missingTarget')
          : target.status === 'error' || target.error !== null
            ? (target.error ?? t('spacePreview.targetsUnavailable'))
            : t('spacePreview.shortcut');

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="spacePreview"
        selected={selected}
        minWidth={SPACE_SHORTCUT_SIZE.minWidth}
        resizeEndClearHeight
        onDoubleClick={openTarget}
        farLabel={{ title: target.title }}
        actions={
          <>
            <Button
              variant="ghost"
              iconOnly
              title={t('spacePreview.openSpace')}
              disabled={!canOpen}
              onClick={openTarget}
            >
              <ArrowUpRight />
            </Button>
            {target.status === 'error' || target.error !== null ? (
              <Button
                variant="ghost"
                iconOnly
                title={t('spacePreview.retry')}
                onClick={target.retry}
              >
                <RefreshCw />
              </Button>
            ) : null}
          </>
        }
      >
        <div
          className="text-fg-default flex items-start"
          data-space-shortcut={data.targetCanvasId}
          data-target-status={target.status}
          style={{
            width:
              typeof liveWidth === 'number'
                ? liveWidth - 2 * NODE_BORDER_WIDTH
                : undefined,
            padding: NODE_CONTENT_SPACING.padding,
            gap: NODE_CONTENT_SPACING.imageTextGap,
            fontFamily: FONT_FAMILY_CSS.default,
            fontSize: typography.size,
            fontWeight: typography.weight,
            lineHeight: typography.lineHeight,
          }}
        >
          <Tooltip content={statusText}>
            <span
              style={{
                marginTop: (typography.size * (typography.lineHeight - 1)) / 2,
              }}
              className={
                failed ? 'text-warning shrink-0' : 'text-fg-muted shrink-0'
              }
            >
              {failed ? (
                <AlertTriangle size={typography.size} aria-hidden />
              ) : (
                <SpaceIcon size={typography.size} aria-hidden />
              )}
            </span>
          </Tooltip>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="line-clamp-2 wrap-anywhere" title={target.title}>
              {target.title}
            </span>
            {target.status === 'ready' ? (
              <SpaceShortcutSummary
                nodeCount={target.nodeCount}
                updatedAt={target.updatedAt}
              />
            ) : null}
          </div>
          {target.status !== 'ready' || target.error !== null ? (
            <span className="sr-only" role="status">
              {statusText}
            </span>
          ) : null}
        </div>
      </NodeWrapper>
    );
  },
);

SpacePreviewNode.displayName = 'SpacePreviewNode';
