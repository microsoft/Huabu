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

import type { SpaceCommandsToolPart } from '@sediment/shared';

export function SpaceCommandCard({ part }: ToolPart<SpaceCommandsToolPart>) {
  const { t } = useTranslation();
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
      const content =
        change.sourceNodeId && change.targetNodeId ? (
          <>
            {translatedChangeLabel(change.label.split(':')[0] || 'Connected')}{' '}
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
        ) : change.nodeId ? (
          <>
            {translatedChangeLabel(change.label.split(':')[0])}:{' '}
            <NodeRef nodeId={change.nodeId} snapshotLabel={change.nodeLabel} />
          </>
        ) : (
          translatedChangeLabel(change.label)
        );
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
                const renderLabel = () => {
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
                  if (change.nodeId) {
                    const prefix = translatedChangeLabel(
                      change.label.split(':')[0],
                    );
                    return (
                      <>
                        {prefix}:{' '}
                        <NodeRef
                          nodeId={change.nodeId}
                          snapshotLabel={change.nodeLabel}
                        />
                      </>
                    );
                  }
                  return translatedChangeLabel(change.label);
                };

                return (
                  <div
                    key={change.id}
                    className="text-fg-muted flex items-center gap-2 pr-2 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {renderLabel()}
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
