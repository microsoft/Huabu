// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import { dismissToast, toast, ToastContainer } from '@/components/Common/Toast';
import en from '@/i18n/resources/en/common.json';
import zhCN from '@/i18n/resources/zh-CN/common.json';
import useCanvasStore from '@/store/canvasStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { MoveSelectionPopover } from './MoveSelectionPopover';

import type * as ToastModule from '@/components/Common/Toast';
import type { MoveSelectionErrorCode } from '@huabu/shared';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { drainPendingSaves, listCanvases, moveCanvasSelection, translate } =
  vi.hoisted(() => ({
    drainPendingSaves: vi.fn().mockResolvedValue(undefined),
    listCanvases: vi.fn(),
    moveCanvasSelection: vi.fn(),
    translate: vi.fn((key: string) => key),
  }));

const moveResult = {
  movedNodeCount: 1,
  movedConversationCount: 0,
  destination: { canvasId: 'destination', title: 'Server destination title' },
};

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal()),
  useTranslation: () => ({ t: translate }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal()),
  listCanvases,
  moveCanvasSelection,
}));

vi.mock('@/store/canvasStore', async (importOriginal) => ({
  ...(await importOriginal()),
  drainPendingSaves,
}));

vi.mock('@/components/Common/Toast', async (importOriginal) => {
  const original = await importOriginal<typeof ToastModule>();
  return { ...original, toast: vi.fn(original.toast) };
});

const sensitiveMessage =
  'Synthetic Space secret; thread-synthetic; /synthetic/private/content; prompt-synthetic; credential-synthetic';
const sensitiveDetails = 'synthetic-private-details';
const knownErrors = {
  MOVE_SOURCE_STALE: 'sourceStale',
  MOVE_SOURCE_NODE_MISSING: 'sourceNodeMissing',
  MOVE_NODE_NOT_MOVABLE: 'nodeNotMovable',
  MOVE_DESTINATION_MISSING: 'destinationMissing',
  MOVE_DESTINATION_SAME_AS_SOURCE: 'sameDestination',
  MOVE_DESTINATION_CREATE_FAILED: 'destinationCreateFailed',
  MOVE_DESTINATION_CLEANUP_FAILED: 'reconcile',
  MOVE_WORLD_NOT_ALLOWED: 'worldNotAllowed',
  MOVE_AGENT_RUNNING: 'agentRunning',
  MOVE_AGENT_TASK_OWNED: 'agentTaskOwned',
  MOVE_AGENT_PENDING_CHANGES: 'agentPendingChanges',
  MOVE_AGENT_HISTORY_INVALID: 'agentHistoryInvalid',
  MOVE_AGENT_CLOSE_FAILED: 'agentCloseFailed',
  MOVE_AGENT_REHOME_FAILED: 'agentRehomeFailed',
  MOVE_ARTIFACT_MISSING: 'artifactMissing',
  MOVE_DESTINATION_CONFLICT: 'destinationConflict',
  MOVE_COMPENSATION_FAILED: 'reconcile',
  MOVE_OUTCOME_UNKNOWN: 'reconcile',
  MOVE_FAILED: null,
} as const satisfies Record<
  MoveSelectionErrorCode,
  keyof typeof en.moveSelection.errors | null
>;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  useWorkspaceStore.setState({
    workspaceId: 'workspace-source',
    isReady: true,
    isSyncing: false,
    spaceTitles: {},
    spaceSummaries: {},
    spaceTitlesStatus: 'ready',
    spaceTitlesError: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  for (const result of vi.mocked(toast).mock.results) {
    if (result.type === 'return') dismissToast(result.value);
  }
  vi.mocked(toast).mockClear();
  translate.mockClear();
  container?.remove();
  root = undefined;
  container = undefined;
  useCanvasStore.setState({
    canvasId: '',
    nodes: [],
    moveSelectionDialogOpen: false,
    moveSelectionAnchor: null,
    pendingSave: false,
  });
  listCanvases.mockReset();
  moveCanvasSelection.mockReset();
  drainPendingSaves.mockReset().mockResolvedValue(undefined);
});

async function submitFailure(error: unknown, duringSave = false) {
  listCanvases.mockResolvedValue({
    canvases: [{ canvasId: 'destination', title: 'Destination' }],
  });
  if (duringSave) drainPendingSaves.mockRejectedValueOnce(error);
  else moveCanvasSelection.mockRejectedValueOnce(error);
  useCanvasStore.setState({
    canvasId: 'source',
    version: 3,
    nodes: [
      {
        id: 'node-selected',
        type: 'note',
        position: { x: 0, y: 0 },
        data: { label: 'Selected' },
        selected: true,
      },
    ],
    moveSelectionDialogOpen: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <MoveSelectionPopover />
        <ToastContainer />
      </>,
    ),
  );
  const move = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === 'moveSelection.confirm',
  );
  expect(move).toBeDefined();
  await act(async () => move?.click());
  expect(drainPendingSaves).toHaveBeenCalledTimes(1);
  expect(moveCanvasSelection).toHaveBeenCalledTimes(duringSave ? 0 : 1);
}

function expectSafeFailure(key: string, rawCode?: string) {
  expect(toast).toHaveBeenCalledExactlyOnceWith(key, {
    tone: 'danger',
    duration: 0,
  });
  expect(translate).toHaveBeenCalledWith(key);
  expect(document.body.textContent).toContain(key);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(useCanvasStore.getState().moveSelectionDialogOpen).toBe(true);
  for (const raw of [sensitiveMessage, sensitiveDetails, rawCode].filter(
    Boolean,
  )) {
    expect(document.body.textContent).not.toContain(raw);
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(raw);
    expect(JSON.stringify(translate.mock.calls)).not.toContain(raw);
  }
}

describe('MoveSelectionPopover', () => {
  async function openPanel() {
    listCanvases.mockResolvedValue({
      canvases: [{ canvasId: 'destination', title: 'Destination' }],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    const trigger = document.createElement('button');
    container.appendChild(trigger);
    trigger.focus();
    useCanvasStore.setState({
      canvasId: 'source',
      nodes: [
        {
          id: 'node-selected',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { label: 'Selected' },
          selected: true,
        },
      ],
    });
    useCanvasStore.getState().setMoveSelectionDialogOpen(true, trigger);
    const host = document.createElement('div');
    container.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<MoveSelectionPopover />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return trigger;
  }

  function destinationSelector() {
    const selector = document.querySelector<HTMLButtonElement>(
      'button[aria-label="moveSelection.selectDestination"]',
    );
    if (!selector) throw new Error('Missing destination selector');
    return selector;
  }

  function escape(target: EventTarget) {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  }

  it('opens a non-modal anchored panel, focuses the selector and restores focus on Escape', async () => {
    const trigger = await openPanel();
    expect(useCanvasStore.getState().moveSelectionAnchor).toBe(trigger);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
    expect(document.activeElement).toBe(destinationSelector());
    expect(document.body.textContent).not.toContain(
      'moveSelection.frameNotice',
    );
    act(() => escape(destinationSelector()));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useCanvasStore.getState().moveSelectionAnchor).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('dismisses the nested selector before the panel and preserves focus', async () => {
    const trigger = await openPanel();
    const selector = destinationSelector();
    await act(async () => selector.click());
    const option = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(option).not.toBeNull();
    act(() => option?.focus());
    act(() => option && escape(option));
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(selector);
    act(() => escape(selector));
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps nested option presses inside the panel and focuses the new name field', async () => {
    await openPanel();
    await act(async () => destinationSelector().click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const option = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) =>
      button.textContent?.includes('moveSelection.createNewDestination'),
    );
    await act(async () => {
      option?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      option?.click();
    });
    const input = document.querySelector<HTMLInputElement>(
      '[name="new-space-title"]',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(destinationSelector().classList.contains('h-8')).toBe(true);
    expect(input?.classList.contains('h-8')).toBe(true);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('dismisses on outside press and resets the shortcut choice on reopening', async () => {
    const trigger = await openPanel();
    const checkbox =
      document.querySelector<HTMLInputElement>('[type="checkbox"]');
    act(() => checkbox?.click());
    expect(checkbox?.checked).toBe(false);
    act(() =>
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      useCanvasStore.getState().setMoveSelectionDialogOpen(true, trigger),
    );
    expect(
      document.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked,
    ).toBe(true);
  });

  it('locks submission and keeps the captured selection while the move is pending', async () => {
    await openPanel();
    let finish: ((value: typeof moveResult) => void) | undefined;
    moveCanvasSelection.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[type="submit"]')?.click(),
    );
    act(() => {
      const panel = document.querySelector('[role="dialog"]');
      if (panel) escape(panel);
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
      useCanvasStore.setState({ nodes: [] });
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled,
    ).toBe(true);
    expect(moveCanvasSelection).toHaveBeenCalledExactlyOnceWith(
      'source',
      expect.objectContaining({
        selectedNodeIds: ['node-selected'],
        createSourcePreview: true,
      }),
    );
    await act(async () => finish?.(moveResult));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not send a move to a changed source after draining saves', async () => {
    await openPanel();
    drainPendingSaves.mockImplementation(async () => {
      useCanvasStore.setState({ canvasId: 'other-source' });
    });

    await act(async () =>
      document.querySelector<HTMLButtonElement>('[type="submit"]')?.click(),
    );
    expect(moveCanvasSelection).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('moveSelection.errors.sourceStale', {
      tone: 'danger',
      duration: 0,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not close a new panel when an old source request completes', async () => {
    const trigger = await openPanel();
    let finish: ((value: typeof moveResult) => void) | undefined;
    moveCanvasSelection.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[type="submit"]')?.click(),
    );
    await act(async () =>
      useCanvasStore.setState({ canvasId: 'another-source' }),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      useCanvasStore.getState().setMoveSelectionDialogOpen(true, trigger),
    );
    await act(async () => finish?.(moveResult));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it.each(['clear', 'replace', 'extend'])(
    'closes when the selected nodes change: %s',
    async (change) => {
      await openPanel();
      act(() =>
        useCanvasStore.setState((state) => ({
          nodes:
            change === 'clear'
              ? state.nodes.map((node) => ({ ...node, selected: false }))
              : change === 'replace'
                ? state.nodes.map((node) => ({ ...node, id: 'different-node' }))
                : [
                    ...state.nodes,
                    {
                      id: 'additional-node',
                      type: 'note',
                      selected: true,
                      position: { x: 100, y: 0 },
                      data: {},
                    },
                  ],
        })),
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(useCanvasStore.getState().moveSelectionAnchor).toBeNull();
      expect(moveCanvasSelection).not.toHaveBeenCalled();
    },
  );

  it('preserves the form when selected node geometry or data changes', async () => {
    await openPanel();
    const checkbox =
      document.querySelector<HTMLInputElement>('[type="checkbox"]');
    act(() => checkbox?.click());
    act(() =>
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((node) => ({
          ...node,
          position: { x: 100, y: 100 },
          data: { ...node.data, label: 'Updated' },
        })),
      })),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[type="checkbox"]')).toBe(checkbox);
    expect(checkbox?.checked).toBe(false);
  });

  it.each(Object.entries(knownErrors))(
    'localizes %s without exposing error messages or details',
    async (code, suffix) => {
      await submitFailure(
        new ApiError(
          409,
          { code, message: sensitiveMessage, details: sensitiveDetails },
          'synthetic fallback',
        ),
      );
      const key = suffix
        ? `moveSelection.errors.${suffix}`
        : 'moveSelection.failed';
      expectSafeFailure(key, code);
      for (const locale of [en, zhCN]) {
        const message = suffix
          ? locale.moveSelection.errors[suffix]
          : locale.moveSelection.failed;
        expect(message).toBeTruthy();
        expect(message).not.toContain('{{');
      }
    },
  );

  it.each([
    undefined,
    '',
    '__proto__',
    'constructor',
    'toString',
    '<img src=x onerror="synthetic-malicious-code">',
    'moveSelection.errors.agentRunning',
  ])('uses the safe fallback for unrecognized code %s', async (code) => {
    await submitFailure(
      new ApiError(
        500,
        { code, message: sensitiveMessage, details: sensitiveDetails },
        'synthetic fallback',
      ),
    );
    expectSafeFailure('moveSelection.failed', code || undefined);
  });

  it.each([
    new Error(sensitiveMessage),
    new TypeError(sensitiveMessage),
    sensitiveMessage,
    {
      code: 'MOVE_AGENT_RUNNING',
      message: sensitiveMessage,
      details: sensitiveDetails,
    },
  ])('uses the safe fallback for non-ApiError failures %#', async (error) => {
    await submitFailure(error);
    expectSafeFailure('moveSelection.failed');
  });

  it.each([
    new Error(sensitiveMessage),
    new ApiError(
      409,
      { code: 'MOVE_AGENT_RUNNING', message: sensitiveMessage },
      'synthetic fallback',
    ),
  ])(
    'keeps save-drain failures generic and does not request a move %#',
    async (error) => {
      await submitFailure(error, true);
      expectSafeFailure('moveSelection.failed');
    },
  );

  it('provides reload and reconciliation guidance in both locales', () => {
    expect(en.moveSelection.failed).toContain(
      'Reload and check both the source and destination Spaces',
    );
    expect(en.moveSelection.errors.reconcile).toContain(
      'reconcile their contents before trying again',
    );
    expect(zhCN.moveSelection.failed).toContain(
      '重新加载并检查源 Space 和目标 Space',
    );
    expect(zhCN.moveSelection.errors.reconcile).toContain(
      '核对并整理两处内容后再尝试',
    );
  });

  it('renders from a stable Canvas store snapshot', () => {
    useCanvasStore.setState({
      canvasId: 'source',
      nodes: [
        {
          id: 'node-selected',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { label: 'Selected' },
          selected: true,
        },
      ],
      moveSelectionDialogOpen: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    expect(() => {
      act(() => root?.render(<MoveSelectionPopover />));
    }).not.toThrow();

    act(() => useCanvasStore.setState({ pendingSave: true }));
    expect(container.innerHTML).toBe('');
  });

  it('lists existing Spaces and the separated create action in one selector', async () => {
    listCanvases.mockResolvedValue({
      canvases: [{ canvasId: 'destination', title: 'Destination' }],
    });
    useCanvasStore.setState({
      canvasId: 'source',
      nodes: [
        {
          id: 'node-selected',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { label: 'Selected' },
          selected: true,
        },
      ],
      moveSelectionDialogOpen: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<MoveSelectionPopover />));
    const destinationSelectors = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="moveSelection.selectDestination"]',
    );
    expect(destinationSelectors).toHaveLength(1);

    act(() => destinationSelectors[0]?.click());
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).map((button) => button.textContent);
    expect(optionLabels).toEqual([
      'Destination',
      'moveSelection.createNewDestination',
    ]);
    expect(document.body.textContent).not.toContain(
      'moveSelection.newDestinationSection',
    );
    const separator = document.querySelector('[role="separator"]');
    expect(separator).not.toBeNull();
    expect(separator?.previousElementSibling?.textContent).toBe('Destination');
    expect(separator?.nextElementSibling?.textContent).toBe(
      'moveSelection.createNewDestination',
    );
  });

  it.each([false, true])(
    'publishes the created destination only in its own workspace (switched=%s)',
    async (switchWorkspace) => {
      listCanvases.mockResolvedValueOnce({ canvases: [] }).mockResolvedValue({
        canvases: [
          {
            canvasId: moveResult.destination.canvasId,
            title: moveResult.destination.title,
          },
        ],
      });
      moveCanvasSelection.mockImplementation(async () => {
        if (switchWorkspace)
          useWorkspaceStore.setState({ workspaceId: 'workspace-other' });
        listCanvases.mockResolvedValue({
          canvases: [
            {
              ...moveResult.destination,
              nodeCount: 1,
              createdAt: 1,
              updatedAt: 2345,
            },
          ],
        });
        return moveResult;
      });
      useCanvasStore.setState({
        canvasId: 'source',
        version: 3,
        nodes: [
          {
            id: 'node-selected',
            type: 'note',
            position: { x: 0, y: 0 },
            data: { label: 'Selected' },
            selected: true,
          },
        ],
        moveSelectionDialogOpen: true,
      });
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      await act(async () => root?.render(<MoveSelectionPopover />));
      const destinationSelect = document.querySelector<HTMLButtonElement>(
        'button[aria-label="moveSelection.selectDestination"]',
      );
      act(() => destinationSelect?.click());
      const newDestination = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      ).find((button) =>
        button.textContent?.includes('moveSelection.createNewDestination'),
      );
      act(() => newDestination?.click());

      const nameInput = document.querySelector<HTMLInputElement>(
        'input[aria-label="moveSelection.newSpaceName"]',
      );
      expect(nameInput).not.toBeNull();
      act(() => {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        setValue?.call(nameInput, 'New destination');
        nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const move = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'moveSelection.confirm',
      );
      await act(async () => move?.click());

      expect(moveCanvasSelection).toHaveBeenCalledWith('source', {
        selectedNodeIds: ['node-selected'],
        destination: { kind: 'new', title: 'New destination' },
        createSourcePreview: true,
        expectedSourceVersion: 3,
      });
      expect(useWorkspaceStore.getState().spaceTitles).toEqual(
        switchWorkspace ? {} : { destination: 'Server destination title' },
      );
      expect(useWorkspaceStore.getState().spaceSummaries).toEqual(
        switchWorkspace
          ? {}
          : { destination: { nodeCount: 1, updatedAt: 2345 } },
      );
      expect(listCanvases).toHaveBeenCalledTimes(switchWorkspace ? 1 : 2);
    },
  );

  it('submits the selected existing destination', async () => {
    listCanvases.mockResolvedValue({
      canvases: [{ canvasId: 'destination', title: 'Destination' }],
    });
    moveCanvasSelection.mockResolvedValue(moveResult);
    useCanvasStore.setState({
      canvasId: 'source',
      version: 3,
      nodes: [
        {
          id: 'node-selected',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { label: 'Selected' },
          selected: true,
        },
      ],
      moveSelectionDialogOpen: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<MoveSelectionPopover />));
    const destinationSelect = document.querySelector<HTMLButtonElement>(
      'button[aria-label="moveSelection.selectDestination"]',
    );
    act(() => destinationSelect?.click());
    const destination = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) => button.textContent === 'Destination');
    act(() => destination?.click());
    const move = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'moveSelection.confirm',
    );
    await act(async () => move?.click());

    expect(moveCanvasSelection).toHaveBeenCalledWith('source', {
      selectedNodeIds: ['node-selected'],
      destination: { kind: 'existing', canvasId: 'destination' },
      createSourcePreview: true,
      expectedSourceVersion: 3,
    });
  });

  it('defaults the source Preview checkbox on and allows disabling it', async () => {
    listCanvases.mockResolvedValue({
      canvases: [{ canvasId: 'destination', title: 'Destination' }],
    });
    useCanvasStore.setState({
      canvasId: 'source',
      version: 3,
      nodes: [
        {
          id: 'node-selected',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { label: 'Selected' },
          selected: true,
        },
      ],
      moveSelectionDialogOpen: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<MoveSelectionPopover />));
    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkbox?.checked).toBe(true);
    act(() => checkbox?.click());
    expect(checkbox?.checked).toBe(false);
  });
});
