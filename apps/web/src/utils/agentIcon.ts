// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Agent-icon helpers.
 *
 * The chosen avatar for an external agent is stored on the Profile itself,
 * inside the opaque `customData` bag under the {@link ICON_KEY} key (the server
 * persists it via Agenetes). These helpers read that value back, fall back to a
 * stable id-derived default when a Profile has never been assigned an icon, and
 * build the `customData` patch used to save a new choice.
 */

import { getDefaultAgentIcon, readAgentIcon } from '@huabu/shared';

import {
  AGENT_ICON_COLORS,
  AGENT_ICON_SELECTABLE_SHAPES,
  type AgentIconValue,
} from '@/components/Common/AgentIcon';

import type { AgentBinding, CustomData } from '@huabu/shared';

export { getDefaultAgentIcon, readAgentIcon };

/**
 * Reserved `customData` key holding the avatar. Kept as a local literal (rather
 * than imported from `@huabu/shared`) so the web bundle stays zod-free.
 */
const ICON_KEY = 'icon';

/**
 * A random icon, used to seed the create form so each new agent starts with a
 * distinct-looking avatar the user can then adjust (there is no Profile id to
 * derive a stable default from yet).
 */
export function randomAgentIcon(): AgentIconValue {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(Math.random() * list.length)];
  return {
    shape: pick(AGENT_ICON_SELECTABLE_SHAPES),
    color: pick(AGENT_ICON_COLORS),
  };
}

/** Snapshot the effective external-agent icon when binding a conversation. */
export function snapshotAgentIcon(
  binding: AgentBinding,
  profiles: readonly { id: string; customData?: CustomData }[],
): AgentIconValue | undefined {
  if (binding.kind !== 'external') return undefined;
  const profile = profiles.find(
    (candidate) => candidate.id === binding.profileId,
  );
  return profile
    ? readAgentIcon(profile)
    : getDefaultAgentIcon(binding.profileId);
}

/** Build the `customData` patch that sets a Profile's icon, preserving other keys. */
export function withAgentIcon(
  customData: CustomData | undefined,
  icon: AgentIconValue,
): CustomData {
  return { ...(customData ?? {}), [ICON_KEY]: icon };
}
