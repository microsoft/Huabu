// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { setSpaceParent } from '@/api/spaceHierarchy';
import { toast } from '@/components/Common/Toast';
import { drainPendingSaves } from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { pageLifecycle } from '@/utils/pageLifecycle';

import { SpaceOrganizationPopover } from './SpaceOrganizationPopover';
import { useSpaceParentMove } from './useSpaceParentMove';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async (): Promise<void> => undefined),
  close: vi.fn(),
  translate: (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));
vi.mock('@/api/spaceHierarchy', () => ({ setSpaceParent: vi.fn() }));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/store/canvasStore', () => ({
  drainPendingSaves: vi.fn(async () => undefined),
}));
vi.mock('@/store/workspaceStore', async () => {
  const { create } = await import('zustand');
  return {
    useWorkspaceStore: create(() => ({
      workspaceId: 'workspace',
      isReady: true,
      isSyncing: false,
      worldCanvasId: 'world',
      spaceTitles: {},
      spaceSummaries: {},
      spaceTitlesStatus: 'ready',
      spaceTitlesError: null,
      refreshSpaceTitles: mocks.refresh,
    })),
  };
});

let root: Root;
let container: HTMLDivElement;
let reference: HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  vi.mocked(drainPendingSaves).mockReset().mockResolvedValue(undefined);
  vi.mocked(setSpaceParent).mockReset().mockResolvedValue({
    canvasId: 'source',
    parentSpaceId: 'target',
    parentEntryNodeId: 'node-entry',
  });
  useWorkspaceStore.setState({
    workspaceId: 'workspace',
    isReady: true,
    isSyncing: false,
    spaceTitlesStatus: 'ready',
    spaceTitlesError: null,
    spaceTitles: {
      source: 'Source',
      descendant: 'Descendant',
      root: 'Root',
      target: 'Target',
      old: 'Old parent',
      world: 'World',
    },
    spaceSummaries: {
      source: {},
      descendant: { parentSpaceId: 'source' },
      root: {},
      target: { parentSpaceId: 'root' },
      old: {},
      world: {},
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  reference = document.createElement('button');
  document.body.appendChild(reference);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  container.remove();
  reference.remove();
});

async function renderDialog() {
  await act(async () =>
    root.render(
      <SpaceOrganizationPopover
        canvasId="source"
        reference={reference}
        onClose={mocks.close}
      />,
    ),
  );
}

function button(name: string) {
  const result = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find(
    (item) =>
      item.getAttribute('aria-label') === name || item.textContent === name,
  );
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}

async function chooseTarget() {
  await act(async () => button('Target').click());
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function deferParentRequest() {
  const request = deferred();
  vi.mocked(setSpaceParent).mockImplementationOnce(async () => {
    await request.promise;
    return {
      canvasId: 'source',
      parentSpaceId: 'target',
      parentEntryNodeId: 'node-entry',
    };
  });
  return request;
}

describe('SpaceOrganizationPopover', () => {
  it('does not present a destination with missing title or ancestry metadata', async () => {
    useWorkspaceStore.setState({
      spaceTitles: { source: 'Source', target: 'Target' },
      spaceSummaries: {
        source: {},
        target: { parentSpaceId: 'root' },
        root: {},
      },
    });
    await renderDialog();
    expect(document.querySelector('button[aria-label="Target"]')).toBeNull();
    await act(async () =>
      useWorkspaceStore.setState((state) => ({
        spaceTitles: { ...state.spaceTitles, root: 'Root' },
      })),
    );
    expect(button('Target').disabled).toBe(false);
  });

  it.each([
    'idle',
    'loading',
    'error',
    'missing-title',
    'missing-parent-title',
  ] as const)(
    'refuses direct promotion with %s metadata and allows it after loading',
    async (status) => {
      useWorkspaceStore.setState({
        spaceTitlesStatus:
          status === 'missing-title' || status === 'missing-parent-title'
            ? 'ready'
            : status,
        spaceTitles:
          status === 'missing-title'
            ? { old: 'Old parent' }
            : status === 'missing-parent-title'
              ? { source: 'Source' }
              : {},
        spaceSummaries: { source: { parentSpaceId: 'old' }, old: {} },
      });
      let action!: ReturnType<typeof useSpaceParentMove>;
      function Harness() {
        action = useSpaceParentMove();
        return null;
      }
      await act(async () => root.render(<Harness />));
      expect(action.canMove('source')).toBe(false);
      await act(async () => {
        await action.move('source', null, 'old');
      });
      expect(setSpaceParent).not.toHaveBeenCalled();
      expect(drainPendingSaves).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith('spacePreview.targetsUnavailable', {
        tone: 'danger',
      });
      await act(async () =>
        useWorkspaceStore.setState({
          spaceTitlesStatus: 'ready',
          spaceTitles: { source: 'Loaded source', old: 'Old parent' },
        }),
      );
      expect(action.canMove('source')).toBe(true);
      await act(async () => {
        await action.move('source', null, 'old');
      });
      expect(setSpaceParent).toHaveBeenCalledExactlyOnceWith('source', {
        parentSpaceId: null,
        expectedParentSpaceId: 'old',
      });
      expect(toast).toHaveBeenLastCalledWith(
        mocks.translate('spaceHierarchy.moved', {
          name: 'Loaded source',
          destination: 'spaceHierarchy.topLevel',
        }),
        { tone: 'success' },
      );
    },
  );

  it('distinguishes a loaded untitled Space from an absent title record', async () => {
    useWorkspaceStore.setState((state) => ({
      spaceTitles: { ...state.spaceTitles, source: null },
    }));
    await renderDialog();
    await chooseTarget();
    expect(setSpaceParent).toHaveBeenCalledOnce();
    expect(toast).toHaveBeenLastCalledWith(
      mocks.translate('spaceHierarchy.moved', {
        name: 'canvasList.untitled',
        destination: 'Root / Target',
      }),
      { tone: 'success' },
    );
  });

  it('rechecks readiness after draining saves before sending a parent request', async () => {
    const saves = deferred();
    vi.mocked(drainPendingSaves).mockReturnValueOnce(saves.promise);
    await renderDialog();
    await chooseTarget();
    await act(async () => {
      useWorkspaceStore.setState({
        spaceTitlesStatus: 'loading',
        spaceTitles: {},
      });
      saves.resolve();
    });
    expect(setSpaceParent).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('spacePreview.targetsUnavailable', {
      tone: 'danger',
    });
  });

  it('moves the explicit source on destination selection without a confirmation dialog', async () => {
    await renderDialog();
    expect(button('Target').disabled).toBe(false);
    for (const name of ['Source', 'Descendant', 'World'])
      expect(document.querySelector(`button[aria-label="${name}"]`)).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain('spaceHierarchy.topLevel');
    expect(document.body.textContent).not.toContain('moveSelection.spaces');
    await chooseTarget();
    expect(setSpaceParent).toHaveBeenCalledExactlyOnceWith('source', {
      parentSpaceId: 'target',
      expectedParentSpaceId: null,
    });
    expect(mocks.refresh).toHaveBeenLastCalledWith(['source', 'target']);
    expect(mocks.close).toHaveBeenCalledOnce();
    const options = vi.mocked(toast).mock.calls.at(-1)?.[1];
    expect(options).toEqual({ tone: 'success' });
  });

  it('keeps promotion out of the destination picker and moves a child without a shortcut warning', async () => {
    useWorkspaceStore.setState((state) => ({
      spaceSummaries: {
        ...state.spaceSummaries,
        source: { parentSpaceId: 'old' },
      },
    }));
    await renderDialog();
    expect(button('Old parent').disabled).toBe(true);
    expect(document.body.textContent).not.toContain(
      'spaceHierarchy.oldEntryKept',
    );
    expect(document.body.textContent).not.toContain(
      'spaceHierarchy.moveToTopLevel',
    );
    await chooseTarget();
    expect(setSpaceParent).toHaveBeenCalledWith('source', {
      parentSpaceId: 'target',
      expectedParentSpaceId: 'old',
    });
    expect(mocks.refresh).toHaveBeenLastCalledWith(['source', 'target', 'old']);
  });

  it('waits for metadata and searches collapsed descendants by path', async () => {
    useWorkspaceStore.setState({ spaceTitlesStatus: 'loading' });
    await renderDialog();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Target"]')).toBeNull();
    await act(async () =>
      useWorkspaceStore.setState({ spaceTitlesStatus: 'ready' }),
    );
    expect(button('Target').disabled).toBe(false);
    await act(async () =>
      button('moveSelection.collapse {"name":"Root"}').click(),
    );
    const input = document.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Missing search input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Target');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Target').textContent).toContain('Root');
    expect(button('Target').disabled).toBe(false);
  });

  it('refreshes and resets selection after a parent conflict', async () => {
    await renderDialog();
    vi.mocked(setSpaceParent).mockRejectedValueOnce(
      new ApiError(
        409,
        { code: 'SPACE_PARENT_CHANGED', message: 'Parent changed' },
        '',
      ),
    );
    mocks.refresh.mockImplementationOnce(async () => {
      useWorkspaceStore.setState((state) => ({
        spaceSummaries: {
          ...state.spaceSummaries,
          source: { parentSpaceId: 'old' },
        },
      }));
    });
    await chooseTarget();
    expect(button('Old parent').getAttribute('aria-pressed')).toBe('true');
    expect(button('Old parent').disabled).toBe(true);
    expect(document.body.textContent).toContain('Parent changed');
    expect(mocks.close).not.toHaveBeenCalled();
    await act(async () => button('Target').click());
    expect(setSpaceParent).toHaveBeenLastCalledWith('source', {
      parentSpaceId: 'target',
      expectedParentSpaceId: 'old',
    });
  });

  it('reports a failure and allows another destination choice without closing', async () => {
    await renderDialog();
    vi.mocked(setSpaceParent).mockRejectedValueOnce(
      new Error('Attachment failed'),
    );
    await chooseTarget();
    expect(button('Target').disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Attachment failed',
    );
    expect(mocks.close).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledExactlyOnceWith('Attachment failed', {
      tone: 'danger',
    });
  });

  it('retries metadata errors and cancels without changing ownership', async () => {
    useWorkspaceStore.setState({
      spaceTitlesStatus: 'error',
      spaceTitlesError: 'Unavailable',
    });
    await renderDialog();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Unavailable',
    );
    await act(async () => button('spacePreview.retry').click());
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(reference);
    expect(setSpaceParent).not.toHaveBeenCalled();
  });

  it('blocks duplicate submits and cancellation while saving', async () => {
    let release!: () => void;
    vi.mocked(drainPendingSaves).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await renderDialog();
    const confirm = button('Target');
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(drainPendingSaves).toHaveBeenCalledOnce();
    expect(document.querySelector('button[aria-label="Target"]')).toBeNull();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(mocks.close).not.toHaveBeenCalled();
    await act(async () => release());
    expect(setSpaceParent).toHaveBeenCalledOnce();
  });

  it('does not submit after the dialog unmounts while draining saves', async () => {
    let release!: () => void;
    vi.mocked(drainPendingSaves).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await renderDialog();
    await chooseTarget();
    await act(async () => root.render(null));
    await act(async () => release());
    expect(setSpaceParent).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('holds close preparation through save draining, the parent request, and metadata refresh', async () => {
    const saves = deferred();
    const request = deferParentRequest();
    const metadata = deferred();
    vi.mocked(drainPendingSaves).mockReturnValueOnce(saves.promise);
    await renderDialog();
    mocks.refresh.mockReturnValueOnce(metadata.promise);
    await chooseTarget();
    const prepared = vi.fn();
    const close = pageLifecycle
      .prepare(new AbortController().signal)
      .then(prepared);
    await act(async () => {});
    expect(prepared).not.toHaveBeenCalled();
    expect(setSpaceParent).not.toHaveBeenCalled();
    await act(async () => saves.resolve());
    expect(setSpaceParent).toHaveBeenCalledOnce();
    expect(prepared).not.toHaveBeenCalled();
    await act(async () => request.resolve());
    expect(mocks.refresh).toHaveBeenLastCalledWith(['source', 'target']);
    expect(prepared).not.toHaveBeenCalled();
    await act(async () => {
      metadata.resolve();
      await close;
    });
    expect(prepared).toHaveBeenCalledOnce();
  });

  it.each(['save', 'parent'] as const)(
    'rejects close preparation on a %s failure despite UI error handling',
    async (stage) => {
      const pending = stage === 'parent' ? deferParentRequest() : deferred();
      if (stage === 'save')
        vi.mocked(drainPendingSaves).mockReturnValueOnce(pending.promise);
      await renderDialog();
      await chooseTarget();
      const close = pageLifecycle.prepare(new AbortController().signal);
      const rejected = expect(close).rejects.toThrow('Move failed');
      await act(async () => {
        pending.reject(new Error('Move failed'));
        await rejected;
      });
      expect(toast).toHaveBeenCalledWith('Move failed', { tone: 'danger' });
      expect(mocks.close).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'failure'] as const)(
    'reconciles a parent request after same-workspace unmount on %s',
    async (outcome) => {
      const request = deferParentRequest();
      await renderDialog();
      await chooseTarget();
      expect(setSpaceParent).toHaveBeenCalledOnce();
      await act(async () => root.render(null));
      mocks.refresh.mockClear();
      const dispatch = vi.spyOn(window, 'dispatchEvent');
      await act(async () => {
        if (outcome === 'failure')
          request.reject(new Error('Attachment failed'));
        else request.resolve();
      });
      expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith([
        'source',
        'target',
      ]);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'canvas-list-changed' }),
      );
      expect(mocks.close).not.toHaveBeenCalled();
      if (outcome === 'failure')
        expect(toast).toHaveBeenCalledExactlyOnceWith('Attachment failed', {
          tone: 'danger',
        });
      else expect(toast).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'failure'] as const)(
    'does not refresh or notify the next workspace after a parent request %s',
    async (outcome) => {
      const request = deferParentRequest();
      await renderDialog();
      await chooseTarget();
      await act(async () =>
        useWorkspaceStore.setState({ workspaceId: 'other' }),
      );
      mocks.refresh.mockClear();
      mocks.close.mockClear();
      const dispatch = vi.spyOn(window, 'dispatchEvent');
      await act(async () => {
        if (outcome === 'failure')
          request.reject(new Error('Attachment failed'));
        else request.resolve();
      });
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'canvas-list-changed' }),
      );
      expect(toast).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
    },
  );

  it('suppresses old success feedback after a workspace switch during refresh', async () => {
    await renderDialog();
    mocks.refresh.mockImplementationOnce(async () => {
      useWorkspaceStore.setState({ workspaceId: 'other' });
    });
    await chooseTarget();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });
});
