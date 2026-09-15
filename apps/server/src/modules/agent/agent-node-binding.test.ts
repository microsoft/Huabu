// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { AgentNodeBindingCoordinator } from './agent-node-binding.js';

import type { AgentNodeTarget } from './agent-thread-resolver.js';
import type { ThreadRecord } from '@agenetes/agenetes';

function target(): AgentNodeTarget {
  return {
    canvasId: 'canvas-a',
    nodeId: 'node-agent',
    threadId: 'thread-a',
    agentBinding: { kind: 'internal' },
    bindingState: 'editing',
  };
}

function record(kind = 'internal', workloadType = 'Deployment'): ThreadRecord {
  return {
    spec: {
      threadId: 'thread-a',
      namespace: { name: 'canvas-a' },
      kind,
      workloadType,
      spec:
        kind === 'external'
          ? { binding: { profileId: 'profile-a', alias: 'Agent' } }
          : {},
    },
    state: { driverState: {} },
    driverSchemaVersion: 1,
  } as ThreadRecord;
}

function harness(existing?: ThreadRecord, history = false) {
  const readRecord = vi.fn(() => existing);
  const promote = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn();
  const acquireTurn = vi.fn((): (() => void) | null => release);
  const coordinator = new AgentNodeBindingCoordinator({
    record: readRecord,
    hasHistory: () => history,
    promote,
    acquireTurn,
  });
  return { coordinator, readRecord, promote, release, acquireTurn };
}

describe('AgentNodeBindingCoordinator', () => {
  it('leaves a genuinely fresh draft Editing without creating execution', async () => {
    const h = harness();
    const node = target();
    expect(await h.coordinator.confirm(node)).toBeNull();
    expect(node.bindingState).toBe('editing');
    expect(h.promote).not.toHaveBeenCalled();
  });

  it.each(['Deployment', 'Job'])(
    'confirms a canonical %s record monotonically',
    async (workloadType) => {
      const h = harness(record('internal', workloadType));
      const node = target();
      expect(await h.coordinator.confirm(node)).toEqual({ kind: 'internal' });
      expect(node.bindingState).toBe('bound');
      expect(h.promote).toHaveBeenCalledOnce();
      await h.coordinator.confirm(node);
      expect(h.promote).toHaveBeenCalledOnce();
    },
  );

  it('completes a failed promotion on the next explicit guarded operation', async () => {
    const h = harness(record());
    const node = target();
    h.promote.mockRejectedValueOnce(new Error('Canvas unavailable'));
    await expect(h.coordinator.confirm(node)).rejects.toThrow(
      'Canvas unavailable',
    );
    expect(node.bindingState).toBe('editing');
    await expect(
      h.coordinator.guardDraftEdit(node, {
        agentBinding: {
          kind: 'external',
          profileId: 'different',
          alias: 'Other',
        },
      }),
    ).rejects.toMatchObject({ code: 'agent_binding_conflict' });
    expect(node.bindingState).toBe('bound');
    expect(h.promote).toHaveBeenLastCalledWith(node, true);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('rejects Bound preparation edits without another ThreadStore lookup', async () => {
    const h = harness();
    const node = { ...target(), bindingState: 'bound' as const };
    await expect(
      h.coordinator.guardDraftEdit(node, {
        agentLaunchOverrides: { additionalInitialPreamble: 'Changed' },
      }),
    ).rejects.toMatchObject({ code: 'agent_binding_conflict' });
    expect(h.readRecord).not.toHaveBeenCalled();
  });

  it.each(['editing', undefined] as const)(
    'confirms unchanged preparation on %s nodes and retains admission',
    async (bindingState) => {
      const h = harness(record());
      const node = { ...target(), bindingState };
      const release = await h.coordinator.guardDraftEdit(node, {
        agentBinding: { kind: 'internal' },
        agentLaunchOverrides: null,
      });
      expect(node.bindingState).toBe('bound');
      expect(h.promote).toHaveBeenCalledWith(node, true);
      expect(h.readRecord).toHaveBeenCalledOnce();
      expect(h.release).not.toHaveBeenCalled();
      release();
      expect(h.release).toHaveBeenCalledOnce();
    },
  );

  it('retries failed promotion when Save resubmits unchanged preparation', async () => {
    const h = harness(record());
    const node = target();
    h.promote.mockRejectedValueOnce(new Error('Write failed'));
    const patch = { agentBinding: { kind: 'internal' } };
    await expect(h.coordinator.guardDraftEdit(node, patch)).rejects.toThrow(
      'Write failed',
    );
    expect(node.bindingState).toBe('editing');
    const release = await h.coordinator.guardDraftEdit(node, patch);
    expect(node.bindingState).toBe('bound');
    expect(h.promote).toHaveBeenCalledTimes(2);
    release();
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it('skips canonical lookup and admission for unchanged Bound preparation', async () => {
    const h = harness();
    await h.coordinator.guardDraftEdit(
      { ...target(), bindingState: 'bound' },
      {
        agentBinding: { kind: 'internal' },
        agentLaunchOverrides: {},
      },
    );
    expect(h.readRecord).not.toHaveBeenCalled();
    expect(h.acquireTurn).not.toHaveBeenCalled();
  });

  it.each([
    { existing: record('external'), binding: { kind: 'internal' } as const },
    {
      existing: record(),
      binding: {
        kind: 'external',
        profileId: 'profile-a',
        alias: 'Agent',
      } as const,
    },
    {
      existing: record('external'),
      binding: {
        kind: 'external',
        profileId: 'other',
        alias: 'Agent',
      } as const,
    },
  ])(
    'promotes canonical existence but rejects conflicting persisted identity %#',
    async ({ existing, binding }) => {
      const h = harness(existing);
      const node = { ...target(), agentBinding: binding };
      await expect(h.coordinator.confirm(node)).rejects.toMatchObject({
        code: 'agent_binding_conflict',
      });
      expect(node.bindingState).toBe('bound');
      expect(h.promote).toHaveBeenCalledOnce();
    },
  );

  it('never resets Bound when its execution record is missing', async () => {
    const h = harness();
    const node = { ...target(), bindingState: 'bound' as const };
    await expect(h.coordinator.confirm(node)).rejects.toMatchObject({
      code: 'execution_record_missing',
    });
    expect(node.bindingState).toBe('bound');
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('does not rebind legacy history without its canonical record', async () => {
    const h = harness(undefined, true);
    await expect(h.coordinator.confirm(target())).rejects.toMatchObject({
      code: 'execution_record_missing',
    });
  });

  it('allows a failed-preparation token with no execution history to retry', async () => {
    const h = harness();
    expect(
      await h.coordinator.confirm({
        ...target(),
        invocationToken: 'failed-preparation',
      }),
    ).toBeNull();
  });

  it.each([
    { ...record(), spec: { ...record().spec, threadId: 'other' } },
    { ...record(), spec: { ...record().spec, namespace: { name: 'other' } } },
    record('unknown'),
    {
      ...record('external'),
      spec: { ...record('external').spec, spec: { binding: {} } },
    },
  ])('rejects invalid canonical identity %#', async (existing) => {
    const h = harness(existing as ThreadRecord);
    await expect(h.coordinator.confirm(target())).rejects.toMatchObject({
      code: 'execution_record_invalid',
    });
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('retains nonblocking draft admission through the actual Canvas write', async () => {
    const h = harness();
    const release = await h.coordinator.guardDraftEdit(target(), {
      agentBinding: { kind: 'external', profileId: 'new', alias: 'New' },
    });
    expect(h.acquireTurn).toHaveBeenCalledWith('thread-a');
    expect(h.release).not.toHaveBeenCalled();
    release();
    expect(h.release).toHaveBeenCalledOnce();
    h.acquireTurn.mockReturnValueOnce(null);
    await expect(
      h.coordinator.guardDraftEdit(target(), {
        agentLaunchOverrides: { additionalInitialPreamble: 'New' },
      }),
    ).rejects.toMatchObject({ code: 'agent_draft_busy' });
  });

  it('allows unchanged preparation echoed by a layout save while admission owns confirmation', async () => {
    const h = harness();
    h.acquireTurn.mockReturnValueOnce(null);
    await h.coordinator.guardDraftEdit(target(), {
      agentBinding: { kind: 'internal' },
      label: 'Updated',
    });
    expect(h.readRecord).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('keeps ask/operate and display metadata outside execution identity', async () => {
    const h = harness(record());
    await h.coordinator.guardDraftEdit(
      { ...target(), bindingState: 'bound' },
      { agentMode: 'operate', label: 'Updated' },
    );
    expect(h.acquireTurn).not.toHaveBeenCalled();
    expect(h.readRecord).not.toHaveBeenCalled();
  });
});
