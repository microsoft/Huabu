import { describe, expect, it } from 'vitest';

import { acpBindingRecipeSchema } from './binding-recipe.js';

const base = { cwd: '/work', alias: 'Agent', autoRestart: true };
const launch = {
  kind: 'acp-harness',
  harnessId: 'copilot',
  options: { autoApprove: true },
};

describe('ACP recipe launch transport', () => {
  it('preserves legacy shell recipes byte-for-byte', () => {
    const recipe = { ...base, command: ' ENV=1 cli --acp "quoted args"  ' };
    expect(acpBindingRecipeSchema.parse(recipe)).toEqual(recipe);
  });
  it('accepts bounded structured launch without a shell fallback', () => {
    const recipe = { ...base, launch };
    expect(acpBindingRecipeSchema.parse(recipe)).toEqual(recipe);
  });
  it.each([
    {},
    { launch, command: 'fallback' },
    { launch: { ...launch, options: { command: 'injected' } } },
    {
      command: 'legacy',
      launchPlan: { version: 1, executable: 'cli', argv: [], env: {} },
    },
  ])('rejects ambiguous or unknown fields %j', (fields) => {
    expect(() =>
      acpBindingRecipeSchema.parse({ ...base, ...fields }),
    ).toThrow();
  });
});
