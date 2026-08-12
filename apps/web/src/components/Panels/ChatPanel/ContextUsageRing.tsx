// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { agentApi } from '@/api/agent';
import { Tooltip } from '@/components/Common/Tooltip';
import { useChatSession } from '@/hooks/useChatSession';
import { selectThreadMessages, useChatStore } from '@/store/chatStore';

/**
 * Authoritative usage reported by an external (ACP) agent itself.
 * `null` means the binding is external but the agent has not pushed a
 * `session_usage_update` yet — the ring should render nothing in that
 * case because any number from the internal fetch would be misleading.
 */
export type ContextUsageOverride = {
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
} | null;

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
  /** Whether the agent is currently streaming */
  isStreaming?: boolean;
  /**
   * Authoritative usage supplied by the bound agent.
   *
   * - `undefined` (default): internal pi-agent binding — fetch usage
   *   from `/agent/context-tokens`, which returns the provider's own
   *   `usage.prompt_tokens + .completion_tokens` from the last turn.
   * - `null`: external (ACP) binding but no usage reported yet — the
   *   ring renders nothing.
   * - `{used, size}`: external binding with agent-reported usage.
   */
  usageOverride?: ContextUsageOverride | undefined;
}

/**
 * Circular progress ring showing the provider's authoritative context
 * window usage. Only renders a filled arc when the provider has
 * reported real `usage` numbers — never extrapolates from a local
 * tokenizer, because that systematically undercounts tool schemas,
 * role overhead and JSON framing.
 */
export const ContextUsageRing = ({
  isStreaming,
  usageOverride,
}: ContextUsageRingProps) => {
  const { t } = useTranslation();
  const { threadId, canvasId } = useChatSession();
  const messages = useChatStore((state) =>
    selectThreadMessages(state, threadId),
  );

  const useInternalFetch = usageOverride === undefined;

  // ---- Backend context usage (internal binding only) ----
  const [internalUsage, setInternalUsage] = useState<{
    tokens: number;
    window: number;
    cost: { amount: number; currency: string } | null;
    fromProvider: boolean;
  } | null>(null);
  const fetchIdRef = useRef(0);

  const fetchContextTokens = useCallback(() => {
    if (!threadId) return;
    const id = ++fetchIdRef.current;
    agentApi
      .fetchContextTokens(threadId, canvasId ?? undefined)
      .then((res) => {
        if (id !== fetchIdRef.current) return;
        setInternalUsage({
          tokens: res.contextTokens,
          window: res.contextWindow,
          cost: res.cost ?? null,
          fromProvider: res.fromProvider ?? false,
        });
      })
      .catch(() => {
        /* ignore */
      });
  }, [threadId, canvasId]);

  // Fetch on mount / thread change / after streaming finishes — skip
  // entirely when an authoritative override is supplied by the agent.
  useEffect(() => {
    if (!useInternalFetch) return;
    fetchContextTokens();
  }, [useInternalFetch, fetchContextTokens, messages.length, isStreaming]);

  // External binding hasn't reported usage yet — render nothing.
  if (usageOverride === null) {
    return null;
  }

  // Internal binding hasn't received a provider-reported turn yet —
  // render nothing. We refuse to show estimated numbers.
  if (useInternalFetch && (!internalUsage || !internalUsage.fromProvider)) {
    return null;
  }

  // ---- Rendering ----
  const usedTokens = usageOverride
    ? usageOverride.used
    : (internalUsage?.tokens ?? 0);
  const contextWindow = usageOverride
    ? usageOverride.size
    : (internalUsage?.window ?? 0);
  // Hide cost rows that are missing or exactly $0 — typical for
  // subscription/OAuth providers (GitHub Copilot) and self-hosted
  // models where pi-ai's price table is 0. Showing "$0.0000" there is
  // misleading.
  const rawCost = usageOverride?.cost ?? internalUsage?.cost ?? null;
  const cost = rawCost && rawCost.amount > 0 ? rawCost : null;

  // Without a valid window we have no denominator to draw against.
  if (contextWindow <= 0) {
    return null;
  }

  const ratio = Math.min(usedTokens / contextWindow, 1);
  const percentage = Math.round(ratio * 100);

  // SVG parameters
  const size = 16;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const arcEnd = ratio * 360;

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  const tooltipContent = (
    <div className="space-y-0.5 text-xs">
      <div>
        <Trans
          i18nKey="chat.contextUsage"
          values={{
            used: formatTokens(usedTokens),
            window: formatTokens(contextWindow),
            percentage,
          }}
          components={{ strong: <strong /> }}
        />
      </div>
      {cost && (
        <div>
          <Trans
            i18nKey="chat.contextCost"
            values={{
              amount: cost.amount.toFixed(4),
              currency: cost.currency,
            }}
            components={{ strong: <strong /> }}
          />
        </div>
      )}
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span
        // Focusable, non-interactive tooltip target (Tooltip wires
        // aria-describedby) — the W3C tooltip pattern.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        aria-label={t('chat.contextUsageAria', {
          used: formatTokens(usedTokens),
          window: formatTokens(contextWindow),
          percentage,
        })}
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
            className="stroke-edge-default"
          />
          {/* Used context arc — starts at 12 o'clock */}
          {usedTokens > 0 && (
            <path
              d={describeArc(cx, cy, radius, 0, arcEnd)}
              fill="none"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              className="stroke-fg-muted"
            />
          )}
        </svg>
      </span>
    </Tooltip>
  );
};
