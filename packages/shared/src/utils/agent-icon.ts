// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type {
  AgentIcon,
  AgentIconBrand,
  CustomData,
} from '../types/api/agent-profile.js';

const SHAPES: readonly AgentIcon['shape'][] = [
  'circle',
  'diamond',
  'spark',
  'flower',
  'cloud',
];
const DEFAULT_SHAPES: readonly AgentIcon['shape'][] = [
  'diamond',
  'spark',
  'flower',
  'cloud',
];
const COLORS: readonly AgentIcon['color'][] = [
  'blue',
  'red',
  'yellow',
  'green',
];
/**
 * Harness logos available as avatars. Each id is the harness id it represents,
 * so a harness maps to its brand by identity.
 */
export const AGENT_ICON_BRANDS: readonly AgentIconBrand[] = [
  'claude',
  'codebuddy',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'hermes',
  'kimi',
  'opencode',
  'pi',
  'qwen',
];
const ICON_KEY = 'icon';

function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

function isShape(value: unknown): value is AgentIcon['shape'] {
  return SHAPES.includes(value as AgentIcon['shape']);
}

function isColor(value: unknown): value is AgentIcon['color'] {
  return COLORS.includes(value as AgentIcon['color']);
}

function isBrand(value: unknown): value is AgentIconBrand {
  return AGENT_ICON_BRANDS.includes(value as AgentIconBrand);
}

/** Return the brand logo for a harness, when Huabu ships one. */
export function getHarnessAgentIconBrand(
  harnessId: string | undefined,
): AgentIconBrand | undefined {
  return isBrand(harnessId) ? harnessId : undefined;
}

/**
 * Apply the creation-time default for a new Profile: the harness logo when one
 * exists, otherwise the given shape avatar unchanged. Profiles that already
 * exist are never rewritten; this only seeds new ones.
 */
export function withHarnessAgentIconBrand(
  icon: AgentIcon,
  harnessId: string | undefined,
): AgentIcon {
  const brand = getHarnessAgentIconBrand(harnessId);
  const { shape, color } = icon;
  return brand ? { shape, color, brand } : { shape, color };
}

/** Return the stable fallback avatar for a Profile id. */
export function getDefaultAgentIcon(profileId: string): AgentIcon {
  const value = hash(profileId);
  return {
    shape: DEFAULT_SHAPES[value % DEFAULT_SHAPES.length],
    color: COLORS[(value >>> 8) % COLORS.length],
  };
}

/** Resolve a Profile's persisted avatar or its stable fallback. */
export function readAgentIcon(profile: {
  id: string;
  customData?: CustomData;
}): AgentIcon {
  const raw = profile.customData?.[ICON_KEY];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const { shape, color, brand } = raw as Record<string, unknown>;
    if (isShape(shape) && isColor(color)) {
      // An unknown brand (saved by a newer client) degrades to the shape.
      return isBrand(brand) ? { shape, color, brand } : { shape, color };
    }
  }
  return getDefaultAgentIcon(profile.id);
}
