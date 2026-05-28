import { Copy } from 'lucide-react';

import { MilkdownMessageCard } from './Card/MilkdownMessageCard';
import { groupAdjacentToolParts } from './groupParts';
import { PlanCard } from './PlanCard';
import { ThinkingCard } from './ThinkingCard';
import { ToolCallCard } from './ToolCallCard';
import {
  CanvasCommandCard,
  isAgentTool,
  MergedAgentToolRow,
  WebSearchToolDisplay,
} from './ToolMessage';
import { NODE_ICON } from '../../config/nodeIcons';
import useCanvasStore from '../../store/canvasStore';
import { useChatStore } from '../../store/chatStore';
import {
  assistantMessageText,
  type AssistantSegment,
  type ResourceLabel,
} from '../../store/chatTypes';
import { copyToClipboard } from '../../utils/io/clipboard';
import { Button } from '../Common/Button';

import type { CanvasNodeType } from '@sediment/shared';

interface AIMessageProps {
  messageId: string;
  segments: AssistantSegment[];
  isStreaming?: boolean;
  resources?: ResourceLabel[];
  hideActions?: boolean;
}

const NoteIcon = NODE_ICON.note;

export const AIMessage = ({
  messageId,
  segments,
  isStreaming,
  resources,
  hideActions,
}: AIMessageProps) => {
  const addNode = useCanvasStore((state) => state.addNode);
  const threadId = useChatStore((s) => s.threadId);

  // Plain-text copy / "add as note" only includes visible text — thinking
  // is internal reasoning and shouldn't bleed into derived artifacts.
  const plainText = assistantMessageText(segments);
  const lastIdx = segments.length - 1;

  // Group adjacent same-internal-tool parts so e.g. a run of three
  // `inspect_nodes` calls collapses into a single merged row.
  const groups = groupAdjacentToolParts(segments);

  return (
    <div className="flex justify-start">
      <div className="flex w-full flex-col gap-1">
        {groups.map((group, gIdx) => {
          if (group.kind === 'tool-group') {
            const internalName = group.internalToolName;
            const parts = group.parts;

            // canvas_commands keeps its rich change-list UI per call,
            // so render each part separately.
            if (internalName === 'canvas_commands') {
              return (
                <div key={`g${gIdx}`} className="flex flex-col gap-1">
                  {parts.map((p) => (
                    <CanvasCommandCard
                      key={p.toolCallId}
                      messageId={messageId}
                      part={p}
                    />
                  ))}
                </div>
              );
            }

            // web_search has its own dedicated source-list card per call.
            if (internalName === 'web_search') {
              return (
                <div key={`g${gIdx}`} className="flex flex-col gap-1">
                  {parts.map((p) => (
                    <WebSearchToolDisplay key={p.toolCallId} part={p} />
                  ))}
                </div>
              );
            }

            // Built-in agent tools (read / grep / find / ls / …) merge
            // into one collapsible row.
            if (internalName && isAgentTool(internalName)) {
              return (
                <MergedAgentToolRow
                  key={`g${gIdx}`}
                  tool={internalName}
                  entries={parts.map((p) => ({ messageId, part: p }))}
                />
              );
            }

            // ACP-native parts (no internalToolName) and any unknown
            // internal tool fall back to the generic per-call renderer.
            return (
              <div key={`g${gIdx}`} className="flex flex-col gap-1">
                {parts.map((p) => (
                  <ToolCallCard key={p.toolCallId} part={p} />
                ))}
              </div>
            );
          }

          const seg = group.segment;
          // The segment's index in the original list — used for "is this
          // the trailing thinking block?" check below.
          const idx = segments.indexOf(seg);

          if (seg.kind === 'thinking') {
            // A thinking segment is "still streaming" only when it's the
            // trailing segment of an in-flight turn — once text starts
            // flowing after it, the thinking phase is done.
            const segStreaming = isStreaming && idx === lastIdx;
            return (
              <ThinkingCard
                key={`g${gIdx}`}
                text={seg.text}
                isStreaming={segStreaming}
              />
            );
          }

          if (seg.kind === 'plan') {
            return <PlanCard key={`g${gIdx}`} entries={seg.entries} />;
          }

          if (seg.kind === 'status') {
            return (
              <div
                key={`g${gIdx}`}
                className="text-fg-subtle ml-1 px-4 text-xs italic"
              >
                {seg.detail ?? seg.status}
              </div>
            );
          }

          // text segment
          return (
            <div
              key={`g${gIdx}`}
              className="text-fg-default bg-surface ml-1 rounded-2xl border border-none px-4 text-sm"
            >
              <div className="leading-relaxed">
                <MilkdownMessageCard content={seg.text} threadId={threadId} />
              </div>
            </div>
          );
        })}

        {!isStreaming && !hideActions && (
          <div className="ml-1 flex items-center gap-1 px-3">
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              className="text-fg-subtle"
              aria-label="Add as note"
              title="Add as note"
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
              aria-label="Copy message"
              title="Copy"
              onClick={() => copyToClipboard(plainText)}
            >
              <Copy />
            </Button>

            {resources && resources.length > 0 && (
              <>
                <span className="bg-edge-default mx-1 h-3 w-px" />
                {resources.map((r, i) => {
                  const Icon =
                    NODE_ICON[r.nodeType as CanvasNodeType] ?? NODE_ICON.note;
                  return (
                    <span
                      key={i}
                      className="bg-bg-default text-fg-subtle inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                      title={r.label}
                    >
                      <Icon size={10} />
                      <span className="max-w-20 truncate">{r.label}</span>
                    </span>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
