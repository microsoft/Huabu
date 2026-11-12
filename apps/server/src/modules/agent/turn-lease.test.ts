// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { acquireAgentTurn, waitForAgentTurnRelease } from './turn-lease.js';

describe('acquireAgentTurn', () => {
  it('admits the same logical ID independently in different namespace owners', () => {
    const a = { name: 'space', ownerId: 'workspace-a' };
    const b = { name: 'space', ownerId: 'workspace-b' };
    const releaseA = acquireAgentTurn('same-id', a);
    const releaseB = acquireAgentTurn('same-id', b);
    try {
      expect(releaseA).not.toBeNull();
      expect(releaseB).not.toBeNull();
      expect(acquireAgentTurn('same-id', a)).toBeNull();
      expect(acquireAgentTurn('same-id', b)).toBeNull();
    } finally {
      releaseA?.();
      releaseB?.();
    }
  });
  it('waits only for its own namespace lease and preserves stable ownership across a root move', async () => {
    const a = {
      name: 'space',
      ownerId: 'workspace-a',
      storage: { root: '/original' },
    };
    const b = { ...a, ownerId: 'workspace-b' };
    const release = acquireAgentTurn('scoped-wait', a);
    expect(release).not.toBeNull();
    expect(
      acquireAgentTurn('scoped-wait', { ...a, storage: { root: '/moved' } }),
    ).toBeNull();
    let aDone = false;
    const waiting = waitForAgentTurnRelease('scoped-wait', 1000, a).then(() => {
      aDone = true;
    });
    try {
      await waitForAgentTurnRelease('scoped-wait', 1000, b);
      expect(aDone).toBe(false);
    } finally {
      release?.();
    }
    await waiting;
    expect(aDone).toBe(true);
  });
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

  it('waits for the current turn to release', async () => {
    const release = acquireAgentTurn('thread-wait');
    let waitCompleted = false;
    const waiting = waitForAgentTurnRelease('thread-wait').then(() => {
      waitCompleted = true;
    });

    await Promise.resolve();
    expect(waitCompleted).toBe(false);

    release?.();
    await waiting;
    expect(waitCompleted).toBe(true);
  });

  it('resolves release waits immediately for an idle thread', async () => {
    await expect(
      waitForAgentTurnRelease('thread-idle'),
    ).resolves.toBeUndefined();
  });

  it('resolves after the timeout when a turn never releases', async () => {
    acquireAgentTurn('thread-wedged');
    await expect(
      waitForAgentTurnRelease('thread-wedged', 5),
    ).resolves.toBeUndefined();
  });
});
