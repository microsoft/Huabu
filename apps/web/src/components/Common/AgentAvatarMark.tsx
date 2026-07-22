import { resolveAvatarDetail } from '@/config/agentAvatarLOD';

import { AgentIcon, agentIconColorHex } from './AgentIcon';
import { BuiltInAgentAvatar } from './BuiltInAgentAvatar';

import type { AgentIconMotion } from './AgentIcon';
import type { QuestionAgentPresentation } from '@/utils/questionAgentPresentation';

export interface AgentAvatarMarkProps {
  /** Resolved identity to draw (external Agent icon or built-in mode). */
  agent: QuestionAgentPresentation;
  /** Rendered avatar diameter (px). Drives the detail tier. */
  size: number;
  /** Optional semantic motion (running wobble). */
  motion?: AgentIconMotion;
  className?: string;
}

/**
 * `AgentAvatarMark` — an agent's identity avatar with size-driven level of
 * detail, shared by every surface that shrinks an avatar toward a dot (the
 * question node's zoomed-out stand-in today; other identity surfaces later).
 *
 * As the size shrinks it sheds detail so the mark never turns to mush:
 *   - `full` (≥ {@link AVATAR_FACE_MIN}) → the detailed avatar with its face;
 *   - `silhouette` (< {@link AVATAR_FACE_MIN}) → the shape without the face;
 *   - `dot` (< {@link AVATAR_DOT_MAX}) → a solid circle in the agent's identity
 *     colour, the crispest possible mark at a few pixels.
 *
 * Status chrome (rings, halos, bubble) is intentionally NOT drawn here — it is
 * layered by the caller so this stays a pure identity mark.
 */
export function AgentAvatarMark({
  agent,
  size,
  motion = 'none',
  className,
}: AgentAvatarMarkProps) {
  const detail = resolveAvatarDetail(size);

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
