// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  abortAgentStreamClaim,
  claimAgentStream,
  hasAgentStreamClaim,
} from './agentStreamCoordinator';

describe('agentStreamCoordinator', () => {
  it('allows only one consumer per canvas thread', () => {
    const first = claimAgentStream('canvas-a', 'thread-a', 'post');
    expect(first).not.toBeNull();
    expect(claimAgentStream('canvas-a', 'thread-a', 'attach')).toBeNull();
    expect(hasAgentStreamClaim('canvas-a', 'thread-a')).toBe(true);

    first?.release();

    const replacement = claimAgentStream('canvas-a', 'thread-a', 'attach');
    expect(replacement).not.toBeNull();
    replacement?.release();
  });

  it('isolates identical thread ids in different canvases', () => {
    const first = claimAgentStream('canvas-a', 'thread-a', 'attach');
    const second = claimAgentStream('canvas-b', 'thread-a', 'attach');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    first?.release();
    second?.release();
  });

  it('aborts and releases the current consumer', () => {
    const claim = claimAgentStream('canvas-a', 'thread-a', 'attach');
    expect(claim).not.toBeNull();

    abortAgentStreamClaim('canvas-a', 'thread-a');

    expect(claim?.signal.aborted).toBe(true);
    expect(hasAgentStreamClaim('canvas-a', 'thread-a')).toBe(false);
  });
});
