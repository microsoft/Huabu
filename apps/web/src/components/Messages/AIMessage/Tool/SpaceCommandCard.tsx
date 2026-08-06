// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * SpaceCommandCard — display-only renderer for the `space_commands`
 * internal tool. Lists the Space mutations the agent performed. Revert
 * is owned by the broadcast-fed ChangeReviewCard (above the chat input),
 * so this card carries no per-change actions.
 */

import { Check, ChevronRight, Command } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  partIsExecuting,
  reconstructChangesFromCommands,
  type ToolPart,
} from './helpers';
import { Loading } from '../../../Common/Loading';
import { NodeRef } from '../../../Common/NodeRef';

import type { SpaceCommandsToolPart } from '@huabu/shared';

export function SpaceCommandCard({ part }: ToolPart<SpaceCommandsToolPart>) {
  const { i18n, t } = useTranslation();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const toolResponse = part.data ?? null;
  const isExecuting = partIsExecuting(part);

  // Reconstruct display rows from the command list. Space state (and
  // revert) is owned by the sync broadcast + ChangeReviewCard, so these
  // rows are display-only (never revertible).
  const displayChanges = useMemo(() => {
    const data =
      toolResponse?.status === 'success'
        ? ((toolResponse.data ?? {}) as Record<string, unknown>)
        : {};
    const commands = (data.commands ?? []) as Array<Record<string, unknown>>;
    return commands.length > 0 ? reconstructChangesFromCommands(commands) : [];
  }, [toolResponse]);

  const hasChanges = displayChanges.length > 0;

  const translatedChangeLabel = (label: string) => {
    const [prefix, ...rest] = label.split(':');
    const suffix = rest.length > 0 ? `:${rest.join(':')}` : '';
    const translatedPrefix =
      {
        Created: t('messages.canvasChange.created'),
        Deleted: t('messages.canvasChange.deleted'),
        Updated: t('messages.canvasChange.updated'),
        Connected: t('messages.canvasChange.connected'),
        Disconnected: t('messages.canvasChange.disconnected'),
        'Moved into frame': t('messages.canvasChange.movedIntoFrame'),
        'Moved out of frame': t('messages.canvasChange.movedOutOfFrame'),
        'Dissolved frame': t('messages.canvasChange.dissolvedFrame'),
        Repositioned: t('messages.canvasChange.repositioned'),
      }[prefix] ?? prefix;
    return `${translatedPrefix}${suffix}`;
  };

  const renderFrameLayoutChange = (change: (typeof displayChanges)[number]) => {
    if (!change.frameLayout || !change.nodeId) return null;

    const { mode, gridCount, sizing } = change.frameLayout;
    const layout =
      mode === 'free'
        ? t('messages.canvasChange.freeLayout')
        : gridCount === undefined
          ? t(
              mode === 'row'
                ? 'messages.canvasChange.rowLayout'
                : mode === 'grid'
                  ? 'messages.canvasChange.gridLayout'
                  : 'messages.canvasChange.columnLayout',
            )
          : t(
              mode === 'row'
                ? 'messages.canvasChange.rows'
                : mode === 'grid'
                  ? 'messages.canvasChange.gridColumns'
                  : 'messages.canvasChange.columns',
              { count: gridCount },
            );

    const sizingLabel =
      sizing === 'hug'
        ? ` · ${t('toolbar.size.fitSize')}`
        : sizing === 'manual'
          ? ` · ${t('toolbar.size.switchManual')}`
          : '';

    return (
      <>
        {t('messages.canvasChange.setFrameLayout', { layout, sizingLabel })}{' '}
        <NodeRef nodeId={change.nodeId} snapshotLabel={change.nodeLabel} />
      </>
    );
  };

  const renderChange = (change: (typeof displayChanges)[number]) => {
    if (change.frameLayout) return renderFrameLayoutChange(change);

    if (change.operation) {
      const alignDetails = {
        left: t('toolbar.align.left'),
        'center-h': t('toolbar.align.center'),
        right: t('toolbar.align.right'),
        top: t('toolbar.align.top'),
        'center-v': t('toolbar.align.middle'),
        bottom: t('toolbar.align.bottom'),
      };
      const reorderDetails = i18n.language.startsWith('zh')
        ? {
            top: '移至最前',
            bottom: '移至最后',
            before: '移至另一节点之前',
            after: '移至另一节点之后',
          }
        : {
            top: 'to front',
            bottom: 'to back',
            before: 'before another node',
            after: 'after another node',
          };
      const detail =
        change.operation === 'aligned'
          ? alignDetails[(change.detail ?? '') as keyof typeof alignDetails]
          : change.operation === 'reordered'
            ? reorderDetails[
                (change.detail ?? '') as keyof typeof reorderDetails
              ]
            : undefined;
      const options = {
        count: change.count,
        detail: detail ?? '',
        nodeType: change.detail ?? '',
      };
      const label =
        {
          aligned: t('messages.commandOperationAligned', options),
          distributed: t('messages.commandOperationDistributed', options),
          reordered: t('messages.commandOperationReordered', options),
          edgeStyle: t('messages.commandOperationEdgeStyle', options),
        }[change.operation] ?? change.label;
      return change.nodeId ? (
        <>
          {label}{' '}
          <NodeRef nodeId={change.nodeId} snapshotLabel={change.nodeLabel} />
        </>
      ) : (
        label
      );
    }

    if (change.sourceNodeId && change.targetNodeId) {
      const verb = translatedChangeLabel(
        change.label.split(':')[0] || 'Connected',
      );
      return (
        <>
          {verb}{' '}
          <NodeRef
            nodeId={change.sourceNodeId}
            snapshotLabel={change.sourceNodeLabel}
          />{' '}
          →{' '}
          <NodeRef
            nodeId={change.targetNodeId}
            snapshotLabel={change.targetNodeLabel}
          />
        </>
      );
    }

    if (change.edgeId) {
      return `${t('messages.canvasChange.disconnected')} ${change.edgeId}`;
    }

    if (change.nodeId) {
      const prefix = translatedChangeLabel(change.label.split(':')[0]);
      return (
        <>
          {prefix}{' '}
          <NodeRef nodeId={change.nodeId} snapshotLabel={change.nodeLabel} />
          {change.targetFrameId ? (
            <>
              {' → '}
              <NodeRef nodeId={change.targetFrameId} />
            </>
          ) : null}
        </>
      );
    }

    return translatedChangeLabel(change.label);
  };

  const statusIcon = isExecuting ? (
    <Loading layout="inline" size="xs" className="text-info" />
  ) : (
    <Check size={12} className="text-fg-muted" />
  );

  if (hasChanges) {
    const title =
      displayChanges.length === 1
        ? t('messages.canvasChangeCount', { count: 1 })
        : t('messages.canvasChangeCount', { count: displayChanges.length });

    if (displayChanges.length === 1) {
      const change = displayChanges[0];
      const content = renderChange(change);
      return (
        <div className="flex justify-start">
          <div className="w-full">
            <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
              {statusIcon}
              <Command size={12} className="text-fg-muted/60 shrink-0" />
              <span className="flex-1 truncate">{content}</span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex justify-start">
        <div className="w-full">
          <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors">
            {statusIcon}
            <Command size={12} className="text-fg-muted/60 shrink-0" />
            <button
              type="button"
              onClick={() => setIsCollapsed((prev) => !prev)}
              className="flex flex-1 items-center gap-1 truncate text-left"
            >
              <span>{title}</span>
              <ChevronRight
                size={10}
                className={`text-fg-muted/50 shrink-0 transition-transform ${!isCollapsed ? 'rotate-90' : ''}`}
              />
            </button>
          </div>

          {!isCollapsed && (
            <div className="border-edge-default/40 ml-4 flex max-h-[24vh] flex-col gap-1 overflow-y-auto border-l py-1 pl-3">
              {displayChanges.map((change) => {
                return (
                  <div
                    key={change.id}
                    className="text-fg-muted flex items-center gap-2 pr-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {renderChange(change)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="w-full">
        <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors">
          {statusIcon}
          <Command size={12} className="text-fg-muted/60 shrink-0" />
          <span className="flex-1 truncate">
            {t('messages.canvasCommands')}
          </span>
        </div>
      </div>
    </div>
  );
}
