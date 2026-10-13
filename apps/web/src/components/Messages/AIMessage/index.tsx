// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Copy, Loader2 } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  groupByActivity,
  describeActivity,
  getActivityStatus,
  projectTaskCompleteResults,
  type ActivitySummary,
  type ActivityEndStatus,
  type ActivityStatus,
  type SegmentGroup,
} from './groupParts';
import { MilkdownMessageCard } from './MilkdownMessageCard';
import { PermissionCard } from './PermissionCard';
import { PlanCard } from './PlanCard';
import { ThinkingCard } from './ThinkingCard';
import { ImageGenerationCard } from './Tool/ImageGenerationCard';
import { MergedAgentToolRow } from './Tool/MergedAgentToolRow';
import { SnapshotNodesCard } from './Tool/SnapshotNodesCard';
import { SpaceCommandCard } from './Tool/SpaceCommandCard';
import { ToolCallCard } from './Tool/ToolCallCard';
import { WebSearchToolDisplay } from './Tool/WebSearchToolDisplay';
import { NODE_ICON } from '../../../config/nodeIcons';
import { useChatSession } from '../../../hooks/useChatSession';
import useCanvasStore from '../../../store/canvasStore';
import {
  assistantMessageText,
  type AssistantSegment,
} from '../../../store/chatTypes';
import { copyToClipboard } from '../../../utils/io/clipboard';
import { Button } from '../../Common/Button';
import { ThinkingIndicator } from '../../Common/ThinkingIndicator';
import { AssistantDisclosure } from '../AssistantDisclosure';

interface AIMessageProps {
  messageId: string;
  segments: AssistantSegment[];
  isStreaming?: boolean;
  endStatus?: ActivityEndStatus;
  hideActions?: boolean;
  enableComments?: boolean;
}

const NoteIcon = NODE_ICON.note;

function renderToolGroup(
  group: Extract<SegmentGroup, { kind: 'tool-group' }>,
  messageId: string,
  key: string,
  showIcon = false,
): React.ReactNode {
  switch (group.variant) {
    case 'space_commands':
      // space_commands keeps its rich change-list UI per call
      // (grouping intentionally never merges these).
      return (
        <div key={key} className="flex flex-col gap-1">
          {group.parts.map((p) => (
            <SpaceCommandCard
              key={p.toolCallId}
              messageId={messageId}
              part={p}
            />
          ))}
        </div>
      );
    case 'web_search':
      return (
        <div key={key} className="flex flex-col gap-1">
          {group.parts.map((p) => (
            <WebSearchToolDisplay key={p.toolCallId} part={p} />
          ))}
        </div>
      );
    case 'image_generation':
      return (
        <div key={key} className="flex flex-col gap-1">
          {group.parts.map((p) => (
            <ImageGenerationCard key={p.toolCallId} part={p} />
          ))}
        </div>
      );
    case 'snapshot_nodes':
      return (
        <div key={key} className="flex flex-col gap-1">
          {group.parts.map((p) => (
            <SnapshotNodesCard key={p.toolCallId} part={p} />
          ))}
        </div>
      );
    case 'agent_tool':
      // Built-in agent tools (read / grep / find / ls / …) merge
      // into one collapsible row keyed by toolName.
      return (
        <MergedAgentToolRow
          key={key}
          tool={group.toolName}
          entries={group.parts.map((p) => ({ messageId, part: p }))}
          showIcon={showIcon}
        />
      );
    case 'generic':
      return (
        <div key={key} className="flex flex-col gap-1">
          {group.parts.map((p) => (
            <ToolCallCard key={p.toolCallId} part={p} showIcon={showIcon} />
          ))}
        </div>
      );
  }
}

function ActivityDisclosure({
  status,
  summary,
  variant = 'activity',
  children,
}: {
  status: ActivityStatus;
  summary: ActivitySummary;
  variant?: 'activity' | 'tools' | 'inline-tools';
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const active = status === 'running';
  const grouped = variant !== 'inline-tools' && summary.visibleGroupCount > 1;
  const steps = t(
    variant !== 'activity'
      ? 'messages.activityToolCalls'
      : status === 'completed'
        ? 'messages.activityCompletedSteps'
        : status === 'interrupted'
          ? 'messages.activityInterruptedSteps'
          : status === 'error'
            ? 'messages.activityErrorSteps'
            : 'messages.activitySteps',
    { count: summary.stepCount },
  );
  const title = active
    ? variant === 'activity'
      ? `${t('messages.activityRunning')} · ${steps}`
      : steps
    : summary.changedFileCount > 0
      ? `${t('messages.activityFilesChanged', { count: summary.changedFileCount })} · ${steps}`
      : steps;

  return (
    <div
      data-assistant-activity={
        grouped && variant === 'activity' ? '' : undefined
      }
      data-assistant-tools={grouped && variant === 'tools' ? '' : undefined}
      data-activity-running={active}
    >
      <AssistantDisclosure
        icon={
          active && variant === 'activity' ? (
            <Loader2 size={12} className="motion-safe:animate-spin" />
          ) : null
        }
        title={title}
        showHeader={grouped}
        collapsed={userCollapsed ?? !active}
        onCollapsedChange={setUserCollapsed}
        bodyClassName={
          grouped ? 'border-edge-default/40 ml-2 border-l pl-3' : ''
        }
      >
        <div
          className="flex flex-col gap-1"
          onPointerDownCapture={() => setUserCollapsed(false)}
          onFocusCapture={() => setUserCollapsed(false)}
        >
          {children}
        </div>
      </AssistantDisclosure>
    </div>
  );
}

export const AIMessage = memo(function AIMessage({
  messageId,
  segments,
  isStreaming,
  endStatus,
  hideActions,
  enableComments = false,
}: AIMessageProps) {
  const { t } = useTranslation();
  const addNode = useCanvasStore((state) => state.addNode);
  const { threadId } = useChatSession();

  // Plain-text copy / "add as note" only includes visible text — thinking
  // is internal reasoning and shouldn't bleed into derived artifacts.
  const displaySegments = projectTaskCompleteResults(segments);
  const plainText = assistantMessageText(displaySegments);
  const groups = groupByActivity(displaySegments).map((entry) =>
    entry.kind === 'activity'
      ? { ...entry, ...describeActivity(entry.groups) }
      : entry,
  );
  const isAwaitingPermission = displaySegments.some(
    (segment) => segment.kind === 'permission' && !segment.resolution,
  );
  const lastSegment = displaySegments.at(-1);
  const terminalStatus =
    endStatus ??
    (lastSegment?.kind === 'status' ? lastSegment.status : undefined);
  const lastGroup = groups.at(-1);
  const showStreamingIndicator =
    isStreaming &&
    !terminalStatus &&
    !isAwaitingPermission &&
    (lastGroup?.kind !== 'activity' ||
      lastGroup.summary.visibleGroupCount <= 1);
  const showMessageActions =
    !isStreaming &&
    !isAwaitingPermission &&
    !hideActions &&
    plainText.trim().length > 0;

  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col gap-1">
        {groups.map((entry, groupIndex) => {
          if (entry.kind === 'activity') {
            const showChildIcons = entry.summary.visibleGroupCount > 1;
            const status = getActivityStatus(groups[groupIndex + 1], {
              isStreaming: Boolean(isStreaming),
              endStatus: terminalStatus,
              isAwaitingPermission,
            });
            const { details } = entry;
            const hasThinking = details.some(
              (detail) => detail.kind === 'thinking',
            );
            return (
              <ActivityDisclosure
                key={entry.startIndex}
                summary={entry.summary}
                status={status}
              >
                {details.map((detail, index) =>
                  detail.kind === 'thinking' ? (
                    <ThinkingCard
                      key={detail.startIndex}
                      plainText={detail.plainText}
                      inActivity={showChildIcons}
                    />
                  ) : (
                    <ActivityDisclosure
                      key={detail.startIndex}
                      variant={hasThinking ? 'tools' : 'inline-tools'}
                      summary={detail.summary}
                      status={
                        index === details.length - 1 ? status : 'completed'
                      }
                    >
                      {detail.groups.map((group, toolIndex) =>
                        renderToolGroup(
                          group,
                          messageId,
                          `tool-${toolIndex}`,
                          showChildIcons,
                        ),
                      )}
                    </ActivityDisclosure>
                  ),
                )}
              </ActivityDisclosure>
            );
          }

          const group = entry.group;
          const idx = entry.startIndex;
          if (group.kind === 'tool-group') {
            return renderToolGroup(group, messageId, `content-${idx}`);
          }

          const seg = group.segment;

          if (seg.kind === 'plan') {
            return <PlanCard key={idx} entries={seg.entries} />;
          }

          if (seg.kind === 'permission') {
            return <PermissionCard key={idx} part={seg} />;
          }

          if (seg.kind === 'status') {
            return (
              <div
                key={idx}
                className="text-fg-subtle ml-1 px-4 text-xs italic"
              >
                {seg.detail ?? seg.status}
              </div>
            );
          }

          // text segment
          return (
            <div
              key={idx}
              className="text-fg-default bg-surface ml-1 rounded-2xl border border-none px-4 text-sm"
            >
              <div className="leading-relaxed">
                <MilkdownMessageCard
                  content={seg.text}
                  threadId={threadId}
                  messageId={messageId}
                  segmentIndex={idx}
                  enableComments={enableComments && showMessageActions}
                />
              </div>
            </div>
          );
        })}

        {showStreamingIndicator && (
          <div className="ml-1 px-4 py-1">
            <ThinkingIndicator />
          </div>
        )}

        {showMessageActions && (
          <div className="ml-1 flex items-center gap-1 px-3">
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              className="text-fg-subtle"
              aria-label={t('messages.addAsNote')}
              title={t('messages.addAsNote')}
              onClick={() => {
                addNode({
                  nodeType: 'note',
                  data: {
                    content: plainText,
                    origin: { type: 'user-from-chat', threadId },
                  },
                });
              }}
            >
              <NoteIcon />
            </Button>

            <Button
              variant="ghost"
              iconOnly
              size="sm"
              className="text-fg-subtle"
              aria-label={t('messages.copyMessage')}
              title={t('messages.copy')}
              onClick={() => copyToClipboard(plainText)}
            >
              <Copy />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
