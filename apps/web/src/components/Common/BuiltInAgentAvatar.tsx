// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `BuiltInAgentAvatar` — the built-in ("Huabu") agent's identity mark: a chubby
 * rounded "Huabu star" with a hand-drawn face, in a fixed Huabu blue. It belongs
 * to the same hand-drawn family as {@link AgentIcon} (organic shape + wobbly
 * face) so the first-party modes read as a friendly hand-made character rather
 * than a flat geometric mascot.
 *
 * The mode is carried by the face itself (no separate badge):
 *   - Chat (`ask`): round eyes + a big open, talking smile.
 *   - Agent (`operate`): calm eyes, a small smile, and two little raised hands —
 *     it acts on the canvas rather than talks.
 *
 * The star silhouette is a spiky polygon fattened by a thick round-joined stroke
 * in its own fill colour, turning the sharp points into plump lobes. Callers
 * representing live execution can opt into the same `working` body wobble the
 * external avatar uses; the face stays upright.
 *
 * The raw hex values are fixed brand-avatar art (the same palette the Huabu logo
 * uses), so they are intentional identity assets — exempt from the semantic
 * design-token rule that applies to normal UI chrome.
 */

import './AgentIcon.css';

import type { AgentIconMotion } from './AgentIcon';
import type { AgentMode } from '@huabu/shared';

/** Huabu-blue star fill. */
const STAR_FILL = '#00A4EF';
/** Hand-drawn ink used for the face and hand strokes. */
const FACE_INK = '#24221E';
/** Five-point star polygon (fattened at render time by a thick round stroke). */
const STAR_POINTS =
  '60,24 71.2,44.6 94.2,48.9 78.1,65.9 81.2,89.1 60,79 38.8,89.1 41.9,65.9 25.8,48.9 48.8,44.6';

export interface BuiltInAgentAvatarProps {
  /** Which built-in mode this avatar represents. */
  mode: AgentMode;
  /** Rendered pixel size (width and height). Defaults to 32. */
  size?: number;
  /** Optional semantic motion. Defaults to `none`. */
  motion?: AgentIconMotion;
  /**
   * Draw the hand-drawn face + hands. Off at small sizes (the silhouette
   * detail tier) where the strokes read as mush; the plump star reads on its
   * own. Defaults to `true`.
   */
  showFace?: boolean;
  className?: string;
}

export function BuiltInAgentAvatar({
  mode,
  size = 32,
  motion = 'none',
  showFace = true,
  className,
}: BuiltInAgentAvatarProps) {
  const isAgent = mode === 'operate';
  const star = (
    <polygon
      points={STAR_POINTS}
      fill={STAR_FILL}
      stroke={STAR_FILL}
      strokeWidth={11}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox="14 10.5 92 92"
      className={className}
      aria-hidden
    >
      {motion === 'working' ? (
        <g className="agent-icon-working-body">{star}</g>
      ) : (
        <g>{star}</g>
      )}
      {showFace ? (
        <>
          <g
            fill="none"
            stroke={FACE_INK}
            strokeWidth="4.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {isAgent ? (
              <>
                {/* Calm eyes + small smile. */}
                <path d="M51 52 L50 59" />
                <path d="M70 52 L69 59" />
                <path d="M55 67 C59 69 63 69 67 67" />
                {/* Two raised arms. */}
                <path d="M41 78 C34 73 32 66 35 60" />
                <path d="M79 78 C86 73 88 66 85 60" />
              </>
            ) : (
              // Chat: a big open, talking smile (round eyes are filled below).
              <path d="M52 66 C56 72 64 72 68 66" />
            )}
          </g>
          {isAgent ? (
            // Two little blue mitten hands.
            <>
              <circle
                cx="34"
                cy="57"
                r="4.4"
                fill={STAR_FILL}
                stroke={FACE_INK}
                strokeWidth="2.4"
              />
              <circle
                cx="86"
                cy="57"
                r="4.4"
                fill={STAR_FILL}
                stroke={FACE_INK}
                strokeWidth="2.4"
              />
            </>
          ) : (
            // Chat: round eyes.
            <>
              <circle cx="52" cy="55" r="3.5" fill={FACE_INK} />
              <circle cx="68" cy="55" r="3.5" fill={FACE_INK} />
            </>
          )}
        </>
      ) : null}
    </svg>
  );
}
