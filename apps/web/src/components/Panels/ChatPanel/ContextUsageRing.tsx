import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { agentApi } from '@/api/agent';
import { Tooltip } from '@/components/Common/Tooltip';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { countTokens } from '@/utils/tokenCount';

/** Maximum context window size in tokens (GPT-4o / Azure OpenAI). */
const CONTEXT_WINDOW = 128_000;

// ==================== SVG arc helpers ====================

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
) {
  if (endAngle - startAngle >= 360) {
    // Full circle — two half-arcs to avoid SVG rendering glitch
    const mid = polarToCartesian(cx, cy, r, startAngle + 180);
    const end = polarToCartesian(cx, cy, r, startAngle + 359.99);
    const start = polarToCartesian(cx, cy, r, startAngle);
    return `M ${start.x} ${start.y} A ${r} ${r} 0 1 1 ${mid.x} ${mid.y} A ${r} ${r} 0 1 1 ${end.x} ${end.y}`;
  }
  const s = polarToCartesian(cx, cy, r, startAngle);
  const e = polarToCartesian(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 1 ${e.x} ${e.y}`;
}

// ==================== Component ====================

interface ContextUsageRingProps {
  /** Current draft text from the input */
  draftText?: string;
  /** Whether the agent is currently streaming */
  isStreaming?: boolean;
}

/**
 * Circular progress ring showing context window usage.
 * - Red arc: tokens already consumed by the conversation history (from backend)
 * - Orange arc: estimated tokens for the current input (draft + selected nodes)
 */
export const ContextUsageRing = ({
  draftText = '',
  isStreaming,
}: ContextUsageRingProps) => {
  const messages = useChatStore((s) => s.messages);
  const threadId = useChatStore((s) => s.threadId);
  const pendingAttachments = useChatStore((s) => s.pendingAttachments);
  const canvasId = useCanvasStore((s) => s.canvasId);
  const nodes = useCanvasStore((s) => s.nodes);

  // ---- Backend context token count ----
  const [actualTokens, setActualTokens] = useState(0);
  const fetchIdRef = useRef(0);

  const fetchContextTokens = useCallback(() => {
    if (!threadId) return;
    const id = ++fetchIdRef.current;
    agentApi
      .fetchContextTokens(threadId, canvasId ?? undefined)
      .then((res) => {
        if (id === fetchIdRef.current) {
          setActualTokens(res.contextTokens);
        }
      })
      .catch(() => {
        /* ignore */
      });
  }, [threadId, canvasId]);

  // Fetch on mount / thread change / after streaming finishes
  useEffect(() => {
    fetchContextTokens();
  }, [fetchContextTokens, messages.length, isStreaming]);

  // ---- Frontend estimated input tokens ----
  const estimatedInputTokens = useMemo(() => {
    let total = 0;

    // Draft text
    if (draftText.trim()) {
      total += countTokens(draftText);
    }

    // Pending attachments — approximate server-side wrapper formatting
    for (const att of pendingAttachments) {
      let attachmentText = '';
      if (att.content) {
        const sourceLabel = att.label ?? 'attachment';
        attachmentText += `[Extracted text from ${sourceLabel}]:\n${att.content}\n`;
      }
      if (att.label) {
        attachmentText += `[Attached ${att.type}: ${att.label}]\n`;
      }
      if (attachmentText) {
        total += countTokens(attachmentText);
      }
    }

    // Selected nodes — approximate "[Selected Nodes]\n${JSON.stringify(...)}"
    const selectedNodes = nodes.filter((n) => n.selected);
    const selectionPayload = selectedNodes
      .map((node) => {
        const data = node.data as Record<string, unknown> | undefined;
        const content = data?.content;
        const label = data?.label;
        const hasContent = typeof content === 'string' && content.length > 0;
        const hasLabel = typeof label === 'string' && label.length > 0;
        if (!hasContent && !hasLabel) return null;
        return {
          id: node.id,
          ...(hasLabel ? { label: label as string } : {}),
          ...(hasContent ? { content: content as string } : {}),
        };
      })
      .filter((entry) => entry !== null);
    if (selectionPayload.length > 0) {
      total += countTokens(
        `[Selected Nodes]\n${JSON.stringify(selectionPayload, null, 2)}`,
      );
    }

    return total;
  }, [draftText, pendingAttachments, nodes]);

  // ---- Rendering ----
  const projectedTotal = actualTokens + estimatedInputTokens;
  const actualRatio = Math.min(actualTokens / CONTEXT_WINDOW, 1);
  const projectedRatio = Math.min(projectedTotal / CONTEXT_WINDOW, 1);
  const percentage = Math.round(projectedRatio * 100);

  // SVG parameters
  const size = 16;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;

  // Arc angles (0–360)
  const actualEnd = actualRatio * 360;
  const projectedEnd = projectedRatio * 360;

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  const tooltipContent = (
    <div className="space-y-0.5 text-xs">
      <div>
        History: <strong>{formatTokens(actualTokens)}</strong>
      </div>
      {estimatedInputTokens > 0 && (
        <div>
          Pending: <strong>~{formatTokens(estimatedInputTokens)}</strong>
        </div>
      )}
      <div>
        Total: {formatTokens(projectedTotal)} / {formatTokens(CONTEXT_WINDOW)} (
        {percentage}%)
      </div>
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span
        tabIndex={0}
        aria-label={`Context usage ${formatTokens(projectedTotal)} of ${formatTokens(CONTEXT_WINDOW)} tokens, ${percentage} percent`}
        className="inline-flex cursor-default items-center justify-center focus:outline-none"
      >
        <svg
          aria-hidden="true"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
        >
          {/* Background ring */}
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-gray-200"
          />
          {/* Estimated input arc (orange) — continues after the red arc */}
          {estimatedInputTokens > 0 && projectedEnd > actualEnd && (
            <path
              d={describeArc(cx, cy, radius, actualEnd, projectedEnd)}
              fill="none"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              className="stroke-amber-500"
            />
          )}
          {/* Actual context arc (red) — starts at 12 o'clock */}
          {actualTokens > 0 && (
            <path
              d={describeArc(cx, cy, radius, 0, actualEnd)}
              fill="none"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              className="stroke-red-500"
            />
          )}
        </svg>
      </span>
    </Tooltip>
  );
};
