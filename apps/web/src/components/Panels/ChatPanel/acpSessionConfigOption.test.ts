import { describe, expect, it } from 'vitest';

import {
  isModeConfigOption,
  isModelConfigOption,
} from './acpSessionConfigOption';

import type { AcpSessionConfigOption } from '@sediment/shared';

// The selectors prefer the modern `configOptions` channel over the legacy
// `availableModels` / `availableModes` lists (microsoft/Huabu#31). These
// predicates decide whether a config option is the modern model / mode
// twin — detection is by semantic `category` with an id fallback, so it
// must hold regardless of the agent's option-id naming.
const option = (partial: Record<string, unknown>): AcpSessionConfigOption =>
  partial as unknown as AcpSessionConfigOption;

describe('AcpSessionSelectors config-option preference', () => {
  it('detects the model picker by category, ignoring the id', () => {
    expect(
      isModelConfigOption(option({ id: 'base_model', category: 'model' })),
    ).toBe(true);
    expect(
      isModeConfigOption(option({ id: 'base_model', category: 'model' })),
    ).toBe(false);
  });

  it('detects the mode picker by category', () => {
    expect(isModeConfigOption(option({ id: 'collab', category: 'mode' }))).toBe(
      true,
    );
    expect(
      isModelConfigOption(option({ id: 'collab', category: 'mode' })),
    ).toBe(false);
  });

  it('falls back to the id when no category is present', () => {
    expect(isModelConfigOption(option({ id: 'Model' }))).toBe(true);
    expect(isModeConfigOption(option({ id: 'MODE' }))).toBe(true);
  });

  it('does not treat other knobs as model/mode twins', () => {
    const thoughtLevel = option({
      id: 'thought_level',
      category: 'thought_level',
    });
    expect(isModelConfigOption(thoughtLevel)).toBe(false);
    expect(isModeConfigOption(thoughtLevel)).toBe(false);

    const fast = option({ id: 'fast', category: 'string' });
    expect(isModelConfigOption(fast)).toBe(false);
    expect(isModeConfigOption(fast)).toBe(false);
  });
});
