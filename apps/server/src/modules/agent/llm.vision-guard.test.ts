// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { shouldStepUpForVision } from './llm.js';

/**
 * Direct coverage for the vision guard predicate that {@link resolveForRole}
 * uses to step a Utility-tier model back up to the (always vision-capable)
 * chat model. Kept separate from the store/secret machinery so the fallback
 * decision is exercised in isolation.
 */
describe('shouldStepUpForVision', () => {
  const TEXT_ONLY = ['text'] as const;
  const VISION = ['text', 'image'] as const;

  it('steps up a vision role carrying an image on a text-only model', () => {
    // `skill` is vision-capable; a screenshot on a text-only Utility model
    // must fall back to chat.
    expect(shouldStepUpForVision('skill', TEXT_ONLY, true)).toBe(true);
  });

  it('stays put when the resolved model already accepts images', () => {
    expect(shouldStepUpForVision('skill', VISION, true)).toBe(false);
  });

  it('stays put when no image is being sent', () => {
    expect(shouldStepUpForVision('skill', TEXT_ONLY, false)).toBe(false);
    expect(shouldStepUpForVision('skill', TEXT_ONLY, undefined)).toBe(false);
  });

  it('never steps up a text-only role even with an image present', () => {
    // `memory` is declared vision:false — its bundle is text-only, so the
    // guard must not force it onto chat.
    expect(shouldStepUpForVision('memory', TEXT_ONLY, true)).toBe(false);
  });
});
