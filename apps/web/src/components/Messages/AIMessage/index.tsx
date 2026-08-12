// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { groupByThinkingPhase, type SegmentGroup } from './groupParts';
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

interface AIMessageProps {
  messageId: string;
  segments: AssistantSegment[];
  isStreaming?: boolean;
  hideActions?: boolean;
}

const NoteIcon = NODE_ICON.note;

/**
 * Render one `tool-group` from `groupAdjacentToolParts`. Extracted
 * so both the phase body (tool calls under a thinking) and the
 * loose-group path (legacy: no thinking opened a phase) share the
 * exact same dispatch.
 */
function renderToolGroup(
  group: Extract<SegmentGroup, { kind: 'tool-group' }>,
  messageId: string,
  key: string,
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
        />
      );
    case 'generic':
      return (
        <div key={key} className="flex flex-col gap-1">
          {group.parts.map((p) => (
            <ToolCallCard key={p.toolCallId} part={p} />
          ))}
        </div>
      );
  }
}

export const AIMessage = ({
  messageId,
  segments,
  isStreaming,
  hideActions,
}: AIMessageProps) => {
  const { t } = useTranslation();
  const addNode = useCanvasStore((state) => state.addNode);
  const { threadId } = useChatSession();

  // Plain-text copy / "add as note" only includes visible text — thinking
  // is internal reasoning and shouldn't bleed into derived artifacts.
  const plainText = assistantMessageText(segments);
  const lastIdx = segments.length - 1;

  // Phase-group adjacent thinking + tool runs so each "agent intent"
  // becomes one collapsible card. Falls back to loose entries for
  // segments that don't belong to any phase (e.g. text segments or
  // tool calls that arrived before the first thinking).
  const phases = groupByThinkingPhase(segments);

  // Show the "still generating" shimmer at the tail of a streaming
  // turn. This is distinct from `ThinkingCard` (which renders the
  // reasoning content): the indicator signals that more output is on
  // the way. Suppressed when the trailing segment is a streaming
  // thinking card, since that card already shows its own "Thinking…"
  // label + spinner and a second one would be redundant. An unresolved
  // permission also suppresses it because the agent is blocked on the user.
  const lastSeg = segments[lastIdx];
  const isAwaitingPermission = segments.some(
    (segment) => segment.kind === 'permission' && !segment.resolution,
  );
  const showStreamingIndicator =
    isStreaming &&
    !isAwaitingPermission &&
    !(lastSeg && lastSeg.kind === 'thinking');
  const showMessageActions =
    !isStreaming &&
    !isAwaitingPermission &&
    !hideActions &&
    plainText.trim().length > 0;

  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col gap-1">
        {phases.map((entry, eIdx) => {
          if (entry.kind === 'phase') {
            // A phase with zero tool groups is just a bare thinking
            // segment — render without children so there's no empty
            // "expand to see tools" affordance.
            if (entry.toolGroups.length === 0) {
              const segStreaming =
                isStreaming && segments.indexOf(entry.thinking) === lastIdx;
              return (
                <ThinkingCard
                  key={`p${eIdx}`}
                  text={entry.thinking.text}
                  isStreaming={segStreaming}
                />
              );
            }
            return (
              <ThinkingCard
                key={`p${eIdx}`}
                text={entry.thinking.text}
                closed={entry.closed}
                isStreaming={isStreaming}
              >
                {entry.toolGroups.map((g, gIdx) =>
                  renderToolGroup(g, messageId, `p${eIdx}-g${gIdx}`),
                )}
              </ThinkingCard>
            );
          }

          const group = entry.group;
          if (group.kind === 'tool-group') {
            return renderToolGroup(group, messageId, `l${eIdx}`);
          }

          const seg = group.segment;
          const idx = segments.indexOf(seg);

          if (seg.kind === 'plan') {
            return <PlanCard key={`l${eIdx}`} entries={seg.entries} />;
          }

          if (seg.kind === 'permission') {
            return <PermissionCard key={`l${eIdx}`} part={seg} />;
          }

          if (seg.kind === 'status') {
            return (
              <div
                key={`l${eIdx}`}
                className="text-fg-subtle ml-1 px-4 text-xs italic"
              >
                {seg.detail ?? seg.status}
              </div>
            );
          }

          // Loose thinking segments (no following tool runs in their
          // own phase) take the simple `ThinkingCard` path. This
          // branch only fires for thinking segments that weren't
          // absorbed by `groupByThinkingPhase` — currently
          // unreachable (every thinking opens a phase), but kept for
          // type-exhaustiveness.
          if (seg.kind === 'thinking') {
            const segStreaming = isStreaming && idx === lastIdx;
            return (
              <ThinkingCard
                key={`l${eIdx}`}
                text={seg.text}
                isStreaming={segStreaming}
              />
            );
          }

          // text segment
          return (
            <div
              key={`l${eIdx}`}
              className="text-fg-default bg-surface ml-1 rounded-2xl border border-none px-4 text-sm"
            >
              <div className="leading-relaxed">
                <MilkdownMessageCard content={seg.text} threadId={threadId} />
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
};
