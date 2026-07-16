import { describe, expect, it } from 'vitest';

import { acquireAgentTurn } from './turn-lease.js';

describe('acquireAgentTurn', () => {
  it('rejects overlapping turns and permits reuse after release', () => {
    const release = acquireAgentTurn('thread-1');
    expect(release).not.toBeNull();
    expect(acquireAgentTurn('thread-1')).toBeNull();

    release?.();
    release?.();

    const nextRelease = acquireAgentTurn('thread-1');
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it('isolates different thread ids', () => {
    const releaseA = acquireAgentTurn('thread-a');
    const releaseB = acquireAgentTurn('thread-b');

    expect(releaseA).not.toBeNull();
    expect(releaseB).not.toBeNull();

    releaseA?.();
    releaseB?.();
  });
});
