// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { AgentIcon, CustomData } from '../types/api/agent-profile.js';

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
    const { shape, color } = raw as Record<string, unknown>;
    if (isShape(shape) && isColor(color)) return { shape, color };
  }
  return getDefaultAgentIcon(profile.id);
}
