// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { WorkloadType } from '@agenetes/protocol';
import type { ModelRole } from '@huabu/shared';

/**
 * IDs of the built-in Skill-authoring commands that run on the Utility
 * tier instead of the Chat model.
 *
 * Canonical source of truth: the `userInvokable: true` system skills
 * shipped under `apps/server/src/prompt/skills/<id>/SKILL.md`. A skill's
 * id is its directory name (see `loader.ts`), so **renaming one of those
 * directories without updating this set silently downgrades authoring to
 * the Chat model** — no error is raised. The `skill-model-routing.test.ts`
 * guard asserts every id here still resolves to a real system skill so
 * that drift fails loudly in CI.
 */
export const UTILITY_SKILL_IDS: ReadonlySet<string> = new Set([
  'create-skill',
  'update-skill',
]);

/** Only Skill authoring commands use Utility; task Skills run on Chat. */
export function modelRoleForInvokedSkills(
  skills: readonly { id: string }[],
): ModelRole {
  return skills.some((skill) => UTILITY_SKILL_IDS.has(skill.id))
    ? 'skill'
    : 'chat';
}

/** How a built-in chat turn should be dispatched given its invoked Skills. */
export interface SkillDispatchPlan {
  /** Model role used to resolve the Chat or Utility tier. */
  readonly modelRole: ModelRole;
  /**
   * A live Deployment bakes its host context (model role included) when
   * created, so it cannot switch tiers mid-life. Skill authoring therefore
   * runs as a fresh `Job` on the Utility role; ordinary task Skills stay on
   * the long-lived Chat `Deployment`.
   */
  readonly workloadType: WorkloadType;
  /**
   * Whether the current live chat handle must be closed before running.
   * Only authoring closes it: tearing down the stale Chat Deployment forces
   * the next normal turn to rehydrate from durable input instead of
   * continuing from a handle baked for a different tier.
   */
  readonly closeLiveHandle: boolean;
}

/**
 * Decide model role, workload lifecycle, and the pre-run close side-effect
 * for a built-in chat turn. Keeping the three coupled decisions in one pure
 * function keeps the route thin and makes the authoring invariant testable.
 */
export function planSkillDispatch(
  skills: readonly { id: string }[],
): SkillDispatchPlan {
  const modelRole = modelRoleForInvokedSkills(skills);
  const runsSkillAuthoring = modelRole === 'skill';
  return {
    modelRole,
    workloadType: runsSkillAuthoring ? 'Job' : 'Deployment',
    closeLiveHandle: runsSkillAuthoring,
  };
}
