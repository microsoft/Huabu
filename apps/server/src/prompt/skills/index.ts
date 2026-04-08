/**
 * Skill Registry
 *
 * Each skill is a self-contained block of domain guidance that the agent
 * can pull on demand via the `use_skill` tool. Skills are never sent
 * proactively — the base system prompt only lists their IDs and one-line
 * descriptions so the LLM knows what's available.
 */

export interface SkillDefinition {
  /** Unique identifier used in the use_skill tool call. */
  id: string;
  /** Short human-readable name. */
  name: string;
  /** One-line description shown in the skill catalogue inside the system prompt. */
  description: string;
  /** Full guidance content returned as the tool result. */
  content: string;
}

// Import individual skills
import { buildFlowchartSkill } from './build-flowchart.js';

const skills: SkillDefinition[] = [buildFlowchartSkill];

export const SKILL_REGISTRY = new Map<string, SkillDefinition>(
  skills.map((s) => [s.id, s]),
);

/**
 * Returns a compact catalogue string for embedding in the system prompt.
 * Format: one skill per line, "- {id}: {description}"
 */
export function getSkillCatalogue(): string {
  return skills.map((s) => `- **${s.id}**: ${s.description}`).join('\n');
}
