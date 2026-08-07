// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PanelsTopLeft } from 'lucide-react';
import { memo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/Common/Button';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper';
import { isEditableTarget } from '@/hooks/shortcuts/isEditableTarget';
import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import type { CanvasRefNodeData } from '@/components/Nodes/types';
import type { Node, NodeProps } from '@xyflow/react';

export type CanvasRefNodeType = Node<CanvasRefNodeData, 'canvasRef'>;

export const CanvasRefNode = memo(
  ({ id, data, selected }: NodeProps<CanvasRefNodeType>) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const title = useWorkspaceStore(
      (state) => state.spaceTitles[data.targetCanvasId],
    );
    const titlesLoaded = useWorkspaceStore((state) => state.spaceTitlesLoaded);
    const isOnlySelected = useCanvasStore((state) => {
      let selectedId: string | null = null;
      for (const node of state.nodes) {
        if (!node.selected) continue;
        if (selectedId !== null) return false;
        selectedId = node.id;
      }
      return selectedId === id;
    });
    const broken = titlesLoaded && title === undefined;
    const openTarget = useCallback(() => {
      if (!broken) navigate(`/canvas/${data.targetCanvasId}`);
    }, [broken, data.targetCanvasId, navigate]);

    useEffect(() => {
      if (!isOnlySelected) return;
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' || isEditableTarget(event.target)) return;
        const target = event.target instanceof Element ? event.target : null;
        if (
          document.querySelector('[aria-modal="true"]') ||
          target?.closest(
            'button, a, select, [role="button"], [role="menuitem"]',
          )
        ) {
          return;
        }
        event.preventDefault();
        openTarget();
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOnlySelected, openTarget]);

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="canvasRef"
        selected={selected}
        allowOverflow
        onDoubleClick={openTarget}
      >
        <div className="flex h-full w-full flex-col">
          <div className="border-edge-default flex items-center gap-2 border-b px-4 py-3">
            <PanelsTopLeft
              className={broken ? 'text-danger' : 'text-fg-muted'}
              size={18}
            />
            <div className="text-fg-default min-w-0 flex-1 truncate text-sm font-medium">
              {!titlesLoaded
                ? t('world.loadingSpace')
                : broken
                  ? t('world.missingSpace')
                  : title || t('world.untitledSpace')}
            </div>
            <Button
              className="nodrag"
              variant="ghost"
              size="sm"
              onClick={openTarget}
              disabled={broken}
            >
              {t('world.openSpace')}
            </Button>
          </div>
          <div className="text-fg-subtle flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm">
            {!titlesLoaded
              ? t('world.loadingPortal')
              : broken
                ? t('world.missingSpaceDescription')
                : t('world.emptyPortal')}
          </div>
        </div>
      </NodeWrapper>
    );
  },
);

CanvasRefNode.displayName = 'CanvasRefNode';
