import { describe, expect, it } from 'vitest';

import {
  InvalidAgentLaunchOverridesError,
  parseAgentLaunchOverrides,
} from './agent-launch-overrides.js';

describe('parseAgentLaunchOverrides', () => {
  it('preserves an explicit empty resource replacement', () => {
    expect(parseAgentLaunchOverrides({ resourceIds: [] })).toEqual({
      resourceIds: [],
    });
  });

  it('accepts a bounded unique resource selection', () => {
    expect(
      parseAgentLaunchOverrides({
        workingDirPath: '/work/project',
        resourceIds: ['web-search', 'generate-image'],
      }),
    ).toEqual({
      workingDirPath: '/work/project',
      resourceIds: ['web-search', 'generate-image'],
    });
  });

  it.each([
    ['duplicates', ['web-search', 'web-search']],
    ['invalid IDs', ['Web Search']],
    [
      'too many IDs',
      Array.from({ length: 65 }, (_, index) => `resource-${index}`),
    ],
  ])('rejects %s', (_label, resourceIds) => {
    expect(() => parseAgentLaunchOverrides({ resourceIds })).toThrow(
      InvalidAgentLaunchOverridesError,
    );
  });
});
