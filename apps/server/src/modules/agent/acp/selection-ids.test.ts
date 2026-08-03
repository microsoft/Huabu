/**
 * The reserved `selections` keys are declared twice, on either side of a
 * boundary that cannot be crossed: `@agenetes/acp-driver` is a subtree
 * pushed to its own upstream and must not depend on Sediment, so
 * `@sediment/shared` carries its own copy for the browser-safe selector
 * normalisation the toolbar renders from.
 *
 * Drift between the two is silent and total: the UI would record a choice
 * under a key the driver never looks for, so it would be persisted, shown
 * in the pill, and never replayed onto the agent. This test is the only
 * thing holding the two declarations together.
 */

import { MODE_SELECTION_ID, MODEL_SELECTION_ID } from '@agenetes/acp-driver';
import { describe, expect, it } from 'vitest';

import {
  MODE_SELECTION_ID as SHARED_MODE_SELECTION_ID,
  MODEL_SELECTION_ID as SHARED_MODEL_SELECTION_ID,
} from '@sediment/shared';

describe('reserved selection ids', () => {
  it('agree across the driver / shared package boundary', () => {
    expect(MODE_SELECTION_ID).toBe(SHARED_MODE_SELECTION_ID);
    expect(MODEL_SELECTION_ID).toBe(SHARED_MODEL_SELECTION_ID);
  });
});
