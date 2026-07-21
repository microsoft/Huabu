/**
 * Agent-icon helpers.
 *
 * The chosen avatar for an external agent is stored on the Profile itself,
 * inside the opaque `customData` bag under the {@link ICON_KEY} key (the server
 * persists it via Agenetes). These helpers read that value back, fall back to a
 * stable id-derived default when a Profile has never been assigned an icon, and
 * build the `customData` patch used to save a new choice.
 */

import {
  AGENT_ICON_COLORS,
  AGENT_ICON_SHAPES,
  type AgentIconColor,
  type AgentIconShape,
  type AgentIconValue,
} from '@/components/Common/AgentIcon';

import type { CustomData } from '@sediment/shared';

/**
 * Reserved `customData` key holding the avatar. Kept as a local literal (rather
 * than imported from `@sediment/shared`) so the web bundle stays zod-free.
 */
const ICON_KEY = 'icon';

function isShape(value: unknown): value is AgentIconShape {
  return (AGENT_ICON_SHAPES as readonly string[]).includes(value as string);
}

function isColor(value: unknown): value is AgentIconColor {
  return (AGENT_ICON_COLORS as readonly string[]).includes(value as string);
}

/** Small deterministic string hash (FNV-1a) for stable default icons. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable, distinct-looking default derived from the profile id. */
export function getDefaultAgentIcon(profileId: string): AgentIconValue {
  const h = hash(profileId);
  return {
    shape: AGENT_ICON_SHAPES[h % AGENT_ICON_SHAPES.length],
    color: AGENT_ICON_COLORS[(h >>> 8) % AGENT_ICON_COLORS.length],
  };
}

/**
 * A random icon, used to seed the create form so each new agent starts with a
 * distinct-looking avatar the user can then adjust (there is no Profile id to
 * derive a stable default from yet).
 */
export function randomAgentIcon(): AgentIconValue {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(Math.random() * list.length)];
  return { shape: pick(AGENT_ICON_SHAPES), color: pick(AGENT_ICON_COLORS) };
}

/** Resolve the effective icon for a Profile (saved value, else default). */
export function readAgentIcon(profile: {
  id: string;
  customData?: CustomData;
}): AgentIconValue {
  const raw = profile.customData?.[ICON_KEY];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { shape, color } = raw as Record<string, unknown>;
    if (isShape(shape) && isColor(color)) return { shape, color };
  }
  return getDefaultAgentIcon(profile.id);
}

/** Build the `customData` patch that sets a Profile's icon, preserving other keys. */
export function withAgentIcon(
  customData: CustomData | undefined,
  icon: AgentIconValue,
): CustomData {
  return { ...(customData ?? {}), [ICON_KEY]: icon };
}
