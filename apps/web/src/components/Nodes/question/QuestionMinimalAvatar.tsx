import { useStore } from '@xyflow/react';
import { clsx } from 'clsx';

import './QuestionAgentBadge.css';

import { AgentAvatarMark } from '@/components/Common/AgentAvatarMark.tsx';
import { avatarSizeForNode } from '@/config/agentAvatarLOD.ts';

import { resolveQuestionBadgeChrome } from './questionBadgeChrome.ts';

import type { QuestionAgentBadgeStatus } from './QuestionAgentBadge.tsx';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation.ts';
import type { CSSProperties } from 'react';

export interface QuestionMinimalAvatarProps {
  /** Node id, used to read the node's canvas size from the store. */
  nodeId: string;
  status: QuestionAgentBadgeStatus;
  agent: QuestionAgentPresentation;
  unread: boolean;
  conflictCount: number;
}

/**
 * The question node's zoomed-out stand-in: its agent avatar, centred on the
 * node, taking over as the node's identity once the card collapses under the
 * semantic-zoom boundary. Shipped counterpart of the `AgentNodePlaygroundPage`
 * zoom-LOD lab.
 *
 * The avatar rides {@link avatarSizeForNode} on the node's on-screen size and
 * sheds detail toward a solid identity dot (via {@link AgentAvatarMark}), so a
 * field of zoomed-out question nodes reads as tidy colour-coded dots. Status is
 * carried by the same ring/halo chrome as the corner badge
 * ({@link resolveQuestionBadgeChrome}).
 *
 * It lives in canvas space (inside the node), so it is rendered at its target
 * *screen* size and counter-scaled by `1/zoom` — mirroring the corner badge —
 * to cancel the viewport transform. It captures pointer events so the whole
 * avatar (including the part that overhangs the shrunken node) forwards
 * double-clicks to the node shell; activation is owned by
 * `NodeWrapper.onDoubleClick`, so the body and the avatar behave identically.
 * Single clicks / drags bubble through to React Flow.
 */
export function QuestionMinimalAvatar({
  nodeId,
  status,
  agent,
  unread,
  conflictCount,
}: QuestionMinimalAvatarProps) {
  const zoom = useStore((s) => s.transform[2]);
  const width = useStore((s) => {
    const node = s.nodeLookup.get(nodeId);
    return (node?.style?.width as number) || node?.measured?.width || 220;
  });
  const height = useStore((s) => {
    const node = s.nodeLookup.get(nodeId);
    return (node?.style?.height as number) || node?.measured?.height || 140;
  });

  const chip = resolveQuestionBadgeChrome({
    status,
    agent,
    unread,
    conflictCount,
  });

  // Curve is defined in SCREEN px; this element lives in canvas space, so we
  // render at the target screen size and counter-scale by 1/zoom below.
  const chipSize = avatarSizeForNode(width * zoom, height * zoom);
  const markSize = Math.round(chipSize * 0.8);

  const chipStyle: CSSProperties = {
    width: chipSize,
    height: chipSize,
    background:
      chip.isOpen || chip.isRunning ? 'transparent' : chip.stickerFill,
    borderColor: chip.ringBorderColor,
    boxShadow: chip.ringBoxShadow,
    ['--question-agent-running-ring' as string]: chip.runningRingColor,
    // The quiet-ring colour token is defined on `.question-agent-badge`; this
    // stand-in does not carry that class, so re-declare it here (matching the
    // badge CSS) or `var(--question-agent-quiet-ring)` resolves to nothing and
    // the border falls back to `currentColor`.
    ['--question-agent-quiet-ring' as string]:
      'color-mix(in srgb, var(--fg-subtle) 55%, var(--bg-surface))',
  };

  return (
    <div
      className="pointer-events-none"
      style={{
        transform: `scale(${zoom > 0 ? 1 / zoom : 1})`,
        transformOrigin: 'center',
      }}
      aria-hidden
    >
      <div
        className={clsx(
          // `pointer-events-auto` so the avatar (incl. its overhang past the
          // shrunken node) forwards double-clicks to the node shell instead of
          // letting them fall through to the canvas.
          'pointer-events-auto relative flex cursor-pointer items-center justify-center rounded-full border-2 border-solid',
          !chip.isOpen && !chip.isRunning && 'shadow-sm',
          chip.isRunning &&
            'question-agent-ring-running border-transparent shadow-none',
          chip.isError &&
            chip.needsAttention &&
            'question-agent-ring-error border-transparent',
          chip.needsAttention && 'question-agent-attention',
        )}
        style={chipStyle}
      >
        {chip.isOpen ? (
          // Same speech bubble as the corner badge's `open` state. Its round
          // body (viewBox centre 22,22 in 44×48) is offset onto the chip
          // centre; the −2 cancels the 2px border (absolute offsets resolve
          // against the padding box). Mirrors the playground lab.
          <svg
            className="pointer-events-none absolute overflow-visible"
            style={{
              left: -chipSize * 0.05 - 2,
              top: -chipSize * 0.05 - 2,
              width: chipSize * 1.1,
              height: chipSize * 1.2,
            }}
            viewBox="0 0 44 48"
            aria-hidden
          >
            <path
              d="M22 2C11 2 2 11 2 22c0 8 4.5 14.5 11 18l-4 6 9-4.5c1.3.3 2.6.5 4 .5 11 0 20-9 20-20S33 2 22 2Z"
              fill={chip.stickerFill}
              stroke="var(--question-border)"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
        <AgentAvatarMark
          agent={agent}
          size={markSize}
          motion={chip.isRunning ? 'working' : 'none'}
          className="relative z-10"
        />
      </div>
    </div>
  );
}
