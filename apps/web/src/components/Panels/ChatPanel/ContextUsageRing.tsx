import { useMemo } from 'react';

import { Tooltip } from '@/components/Common/Tooltip';
import { useChatStore } from '@/store/chatStore';
import { countTokens } from '@/utils/tokenCount';

/** Maximum context window size in tokens (GPT-4o / Azure OpenAI). */
const CONTEXT_WINDOW = 128_000;

/**
 * Small circular progress ring that shows how much of the context window
 * has been consumed by the current session's message history.
 * Hovering reveals the exact token count.
 */
export const ContextUsageRing = () => {
  const messages = useChatStore((s) => s.messages);

  const tokenCount = useMemo(() => {
    let total = 0;
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        total += countTokens(msg.content);
      } else if (msg.role === 'tool') {
        total += countTokens(JSON.stringify(msg.toolResponse));
      }
    }
    return total;
  }, [messages]);

  const ratio = Math.min(tokenCount / CONTEXT_WINDOW, 1);
  const percentage = Math.round(ratio * 100);

  // SVG ring parameters
  const size = 20;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);

  // Color coding: green → yellow → red
  const ringColor =
    percentage < 50
      ? 'stroke-gray-400'
      : percentage < 80
        ? 'stroke-amber-500'
        : 'stroke-red-500';

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  const tooltipContent = (
    <div className="text-xs">
      <span>
        {formatTokens(tokenCount)} / {formatTokens(CONTEXT_WINDOW)} tokens (
        {percentage}%)
      </span>
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span className="inline-flex cursor-default items-center justify-center">
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
        >
          {/* Background ring */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-gray-200"
          />
          {/* Progress ring */}
          {tokenCount > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              className={ringColor}
            />
          )}
        </svg>
      </span>
    </Tooltip>
  );
};
