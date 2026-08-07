// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AgentIcon, agentIconColorHex } from './AgentIcon';
import { BuiltInAgentAvatar } from './BuiltInAgentAvatar';

import type { AgentIconMotion } from './AgentIcon';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';

/**
 * Avatar detail tier. The caller decides which to draw from the rendered size
 * (the question takeover uses `MARK_FACE_MIN`): `full` draws the agent's face,
 * `dot` collapses to a solid identity circle once the mark is too small for a
 * face to read.
 */
export type AvatarDetail = 'full' | 'dot';

export interface AgentAvatarMarkProps {
  /** Resolved identity to draw (external Agent icon or built-in mode). */
  agent: QuestionAgentPresentation;
  /** Rendered avatar diameter (px). */
  size: number;
  /** Optional semantic motion (running wobble). */
  motion?: AgentIconMotion;
  /** Detail tier to draw. The caller picks it from {@link size} (the question
   * takeover uses `MARK_FACE_MIN`): `full` shows the face, `dot` collapses to a
   * solid identity circle. */
  detail: AvatarDetail;
  className?: string;
}

/**
 * `AgentAvatarMark` — an agent's identity avatar, shared by every surface that
 * shrinks an avatar toward a dot (the question node's zoomed-out stand-in
 * today; other identity surfaces later).
 *
 * The caller picks the detail tier from the rendered size so the mark never
 * turns to mush:
 *   - `full` → the detailed avatar with its face;
 *   - `dot`  → a solid circle in the agent's identity colour, the crispest
 *     possible mark at a few pixels.
 *
 * Status chrome (rings, halos, bubble) is intentionally NOT drawn here — it is
 * layered by the caller so this stays a pure identity mark.
 */
export function AgentAvatarMark({
  agent,
  size,
  motion = 'none',
  detail,
  className,
}: AgentAvatarMarkProps) {
  if (detail === 'dot') {
    const identityColor =
      agent.kind === 'external'
        ? agentIconColorHex(agent.icon.color)
        : '#00A4EF';
    return (
      <span
        aria-hidden
        className={className}
        style={{
          display: 'block',
          width: size,
          height: size,
          borderRadius: '50%',
          background: identityColor,
          // Hairline light ring so the dot separates from the note behind it.
          boxShadow:
            'inset 0 0 0 1px color-mix(in srgb, white 45%, transparent)',
        }}
      />
    );
  }

  const withFace = detail === 'full';

  return agent.kind === 'external' ? (
    <AgentIcon
      shape={agent.icon.shape}
      color={agent.icon.color}
      size={size}
      withFace={withFace}
      motion={motion}
      className={className}
    />
  ) : (
    <BuiltInAgentAvatar
      mode={agent.mode}
      size={size}
      showFace={withFace}
      motion={motion}
      className={className}
    />
  );
}
