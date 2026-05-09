/**
 * `use_skill` handler — loads on-demand guidance from the skill registry.
 */

import { SKILL_REGISTRY } from '../../../../prompt/skills/index.js';

export interface UseSkillArgs {
  skillId: string;
}

export async function handleUseSkill(args: UseSkillArgs): Promise<string> {
  const skillId = typeof args.skillId === 'string' ? args.skillId.trim() : '';
  const skill = SKILL_REGISTRY.get(skillId);
  if (!skill) {
    const available = [...SKILL_REGISTRY.keys()].join(', ');
    throw new Error(
      `Unknown skill: "${skillId}". Available skills: ${available || '(none registered)'}`,
    );
  }
  return skill.content;
}
