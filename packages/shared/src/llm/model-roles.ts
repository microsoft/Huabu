// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Model Role Routing — role catalog.
 *
 * Single source of truth for every LLM call site ("role") in Huabu and
 * which capability tier it belongs to. The server's `resolveModelForRole`
 * maps a role → a concrete model via the two-layer binding config
 * (per-role override → tier config → chat fallback); this file only
 * declares the roles and their static metadata.
 *
 * Data, not logic: adding a future call site (e.g. `conversationTitle`,
 * `compaction`, `router`) is a one-line addition here plus referencing the
 * role at the call site — no scattered magic strings.
 *
 * No runtime dependencies (pure data) so it imports cleanly into either the
 * server or the web bundle. See docs/proposals/model-role-routing.md.
 */

/** Capability tier a role defaults to. */
export type ModelTier = 'chat' | 'utility';

/** Static metadata describing one LLM call site. */
export interface ModelRoleInfo {
  /** Tier this role resolves through by default. */
  readonly defaultTier: ModelTier;
  /**
   * Whether this role may send image parts to the model. Drives the
   * resolver's vision guard: when `true` and an image is actually being
   * sent, a resolved model that cannot accept images is stepped up to a
   * vision-capable tier (ultimately chat).
   */
  readonly vision: boolean;
  /** Human-readable label for the settings UI / docs. */
  readonly label: string;
}

/**
 * The role catalog. Keys are the stable role identifiers referenced at
 * call sites (`llmComplete(ctx, { role: 'contentMeta' })`).
 */
export const MODEL_ROLES = {
  chat: { defaultTier: 'chat', vision: true, label: 'Chat agent' },
  memory: {
    defaultTier: 'utility',
    vision: false,
    label: 'Memory curation',
  },
  skill: {
    defaultTier: 'utility',
    vision: true,
    label: 'Skill authoring',
  },
  imageLabel: {
    defaultTier: 'utility',
    vision: true,
    label: 'Image labeling',
  },
  frameLabel: {
    defaultTier: 'utility',
    vision: false,
    label: 'Frame labeling',
  },
  contentMeta: {
    defaultTier: 'utility',
    vision: false,
    label: 'Summary / keywords / label',
  },
} as const satisfies Record<string, ModelRoleInfo>;

/** A registered role identifier. */
export type ModelRole = keyof typeof MODEL_ROLES;

/** All role identifiers, for iteration (e.g. building the override UI). */
export const MODEL_ROLE_IDS = Object.keys(MODEL_ROLES) as ModelRole[];
