/**
 * Central registry for harness-specific setup behavior.
 */

export interface HarnessInfo {
  name: string;
  /** CLI binary used for PATH detection. */
  binary: string;
  /** `--agent` value for `npx skills add`. */
  skillsAgent: string;
  /** Where the system prompt should be placed in the workspace. */
  prompt: { dir: string; filename: string };
}

export const HARNESS_REGISTRY: Record<string, HarnessInfo> = {
  claude: {
    name: 'claude',
    binary: 'claude',
    skillsAgent: 'claude-code',
    prompt: { dir: '.', filename: 'CLAUDE.md' },
  },
  copilot: {
    name: 'copilot',
    binary: 'copilot',
    skillsAgent: 'github-copilot',
    prompt: { dir: '.github', filename: 'copilot-instructions.md' },
  },
  codex: {
    name: 'codex',
    binary: 'codex',
    skillsAgent: 'codex',
    prompt: { dir: '.', filename: 'AGENTS.md' },
  },
};
