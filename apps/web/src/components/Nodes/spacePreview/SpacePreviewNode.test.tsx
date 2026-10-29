// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpacePreviewNode } from './SpacePreviewNode';
import {
  OPEN_SPACE_SHORTCUT_EVENT,
  RENAME_SPACE_SHORTCUT_EVENT,
} from './spaceShortcutEvents';

import type { SpaceAgentActivity } from '@huabu/shared';
import type { Node } from '@xyflow/react';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openConversation: vi.fn(),
  rename: vi.fn(),
  setSpaceTitle: vi.fn(),
  refreshTitles: vi.fn(),
  activity: {
    status: 'ready',
    activity: [] as SpaceAgentActivity,
    updatedAt: 0,
  },
  spaceSummaries: {} as Record<
    string,
    { parentSpaceId: string; parentEntryNodeId: string }
  >,
  target: {
    title: 'Research',
    nodeCount: undefined as number | undefined,
    updatedAt: undefined as number | undefined,
    status: 'ready',
    error: null as string | null,
    retry: vi.fn(),
  },
  state: {
    canvasId: 'source',
    nodes: [] as Node[],
    _setStateNoAutosave: vi.fn(),
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/store/previewWorkspace/actions', () => ({
  openSpaceConversation: mocks.openConversation,
}));
vi.mock('./useSpaceShortcutTarget', () => ({
  useSpaceShortcutTarget: () => mocks.target,
}));
vi.mock('@/api/spaceCard', () => ({ renameSpace: mocks.rename }));
vi.mock('@/store/acpProfilesStore', () => ({
  useAcpProfilesStore: (
    selector: (state: { profiles: never[]; init: () => void }) => unknown,
  ) => selector({ profiles: [], init: vi.fn() }),
}));
vi.mock('./useSpaceCardActivity', () => ({
  useSpaceCardActivity: () => mocks.activity,
  refreshSpaceCardActivity: vi.fn(),
}));
vi.mock('./useSpaceAgentFit', () => ({
  useSpaceAgentFit: () => ({
    rowRef: { current: null },
    probesRef: { current: null },
    visibleCount: 2,
  }),
}));
vi.mock('@/store/canvasStore', () => ({
  default: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}));
vi.mock('@/store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (
      selector: (state: {
        spaceSummaries: typeof mocks.spaceSummaries;
        workspaceId: string;
        worldCanvasId: string;
      }) => unknown,
    ) =>
      selector({
        spaceSummaries: mocks.spaceSummaries,
        workspaceId: 'workspace',
        worldCanvasId: 'world',
      }),
    {
      getState: () => ({
        workspaceId: 'workspace',
        spaceTitles: { target: mocks.target.title },
        setSpaceTitle: mocks.setSpaceTitle,
        refreshSpaceTitles: mocks.refreshTitles,
      }),
    },
  ),
}));
vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: { nodeLookup: Map<string, Node> }) => unknown) =>
    selector({
      nodeLookup: new Map(mocks.state.nodes.map((node) => [node.id, node])),
    }),
}));
vi.mock('@/components/Common/Tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/Nodes/NodeWrapper', () => ({
  NodeWrapper: ({
    children,
    actions,
    overflow,
    onDoubleClick,
  }: {
    children: ReactNode;
    actions: ReactNode;
    overflow: ReactNode;
    onDoubleClick: () => void;
  }) => (
    <div data-wrapper onDoubleClick={onDoubleClick}>
      <div data-primary-actions>{actions}</div>
      <div data-overflow-actions>{overflow}</div>
      {children}
    </div>
  ),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spaceSummaries = {};
  mocks.state.canvasId = 'source';
  mocks.target.title = 'Research';
  mocks.target.nodeCount = undefined;
  mocks.target.updatedAt = undefined;
  mocks.target.status = 'ready';
  mocks.target.error = null;
  mocks.rename.mockResolvedValue({ title: 'Renamed', updatedAt: 1 });
  mocks.activity = {
    status: 'ready',
    activity: [],
    updatedAt: 0,
  };
  mocks.state.nodes = [
    {
      id: 'shortcut',
      type: 'spacePreview',
      position: { x: 1, y: 2 },
      data: {
        type: 'spacePreview',
        targetCanvasId: 'target',
        widthMode: 'auto',
      },
      style: { width: 360 },
    },
  ];
  mocks.state._setStateNoAutosave.mockImplementation((patch) =>
    Object.assign(mocks.state, patch),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function render(widthMode: 'auto' | 'fixed' = 'auto') {
  act(() =>
    root.render(
      <SpacePreviewNode
        id="shortcut"
        type="spacePreview"
        selected
        data={{ type: 'spacePreview', targetCanvasId: 'target', widthMode }}
        dragging={false}
        draggable
        selectable
        deletable
        isConnectable
        zIndex={0}
        positionAbsoluteX={1}
        positionAbsoluteY={2}
      />,
    ),
  );
}
function open() {
  act(() =>
    host
      .querySelector<HTMLElement>('[data-wrapper]')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
  );
  act(() =>
    window.dispatchEvent(
      new CustomEvent(OPEN_SPACE_SHORTCUT_EVENT, {
        detail: { nodeId: 'shortcut' },
      }),
    ),
  );
  act(() =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="spacePreview.openSpace"]')
      ?.click(),
  );
}

function editTitle(value: string) {
  const input = host.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (!input || !setter) throw new Error('Title editor is unavailable');
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

it('leaves canonical entry deletion to the shared More menu instead of adding a toolbar button', () => {
  mocks.spaceSummaries = {
    target: { parentSpaceId: 'source', parentEntryNodeId: 'shortcut' },
  };
  render();
  expect(
    host.querySelector('button[aria-label="canvasList.deleteCanvas"]'),
  ).toBeNull();
  expect(host.querySelectorAll('button')).toHaveLength(3);
  expect(
    host.querySelector('button[aria-label="spacePreview.openSpace"]'),
  ).not.toBeNull();
});
describe('Space Shortcut production node', () => {
  it('places Rename and error Retry in More, leaving Open Space as the primary action', () => {
    mocks.target.error = 'Offline';
    render();
    const primary = host.querySelector('[data-primary-actions]');
    const overflow = host.querySelector('[data-overflow-actions]');
    expect(primary?.querySelectorAll('button')).toHaveLength(1);
    expect(
      primary?.querySelector('[aria-label="spacePreview.openSpace"]'),
    ).not.toBeNull();
    const rename = overflow?.querySelector<HTMLButtonElement>(
      '[aria-label="spacePreview.rename"]',
    );
    const retry = overflow?.querySelector<HTMLButtonElement>(
      '[aria-label="spacePreview.retry"]',
    );
    expect(rename?.getAttribute('role')).toBe('menuitem');
    expect(rename?.textContent).toBe('spacePreview.rename');
    expect(retry?.getAttribute('role')).toBe('menuitem');
    expect(retry?.textContent).toBe('spacePreview.retry');
    act(() => retry?.click());
    expect(mocks.target.retry).toHaveBeenCalledOnce();
    act(() => rename?.click());
    expect(host.querySelector('textarea')).not.toBeNull();
  });

  it('hides Retry from More when healthy and disables Rename for missing targets', () => {
    render();
    expect(host.querySelector('[aria-label="spacePreview.retry"]')).toBeNull();
    mocks.target.status = 'missing';
    render();
    expect(
      host.querySelector<HTMLButtonElement>(
        '[data-overflow-actions] [aria-label="spacePreview.rename"]',
      )?.disabled,
    ).toBe(true);
    expect(
      host.querySelector(
        '[data-overflow-actions] [aria-label="spacePreview.retry"]',
      ),
    ).not.toBeNull();
  });
  it.each(['ready', 'loading', 'error'])(
    'opens the Space from activity-row whitespace while activity is %s',
    (status) => {
      mocks.activity.status = status;
      mocks.activity.activity = Array.from({ length: 3 }, (_, index) => ({
        nodeId: `node-${index}`,
        threadId: `thread-${index}`,
        title: `Session ${index}`,
        status: 'running',
      }));
      render();
      const row = host.querySelector('[data-space-agent-activity]');
      if (!row) throw new Error('Missing activity row');
      for (const control of row.querySelectorAll('button')) {
        act(() =>
          (control.querySelector('svg') ?? control).dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true }),
          ),
        );
      }
      expect(mocks.navigate).not.toHaveBeenCalled();
      act(() =>
        (row.querySelector('[role="status"]') ?? row).dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true }),
        ),
      );
      expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/canvas/target', {
        state: { returnToSpace: 'source', workspaceId: 'workspace' },
      });
    },
  );

  it('opens the chosen original conversation without navigating away from the parent', () => {
    mocks.activity.activity = [
      {
        nodeId: 'node-agent-1',
        threadId: 'thread-1',
        title: 'First review',
        status: 'running',
        agentBinding: { kind: 'internal' },
      },
      {
        nodeId: 'node-agent-2',
        threadId: 'thread-2',
        title: 'Second review',
        status: 'unread',
        agentBinding: { kind: 'internal' },
      },
    ];
    render();
    const button = host.querySelector<HTMLElement>(
      'button[data-space-agent-thread="thread-2"]',
    );
    expect(button).not.toBeNull();
    act(() => button?.click());
    expect(mocks.openConversation).toHaveBeenCalledExactlyOnceWith(
      'target',
      'node-agent-2',
      'thread-2',
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')).toBeNull();
  });
  it.each(['shortcut', 'child', 'world'])(
    'shows a small leading Space icon on %s cards without changing width',
    (kind) => {
      if (kind === 'child')
        mocks.spaceSummaries = {
          target: { parentSpaceId: 'source', parentEntryNodeId: 'shortcut' },
        };
      if (kind === 'world') mocks.state.canvasId = 'world';
      mocks.target.title = 'Medium Space Name';
      render();
      const marker = host.querySelector('[data-space-type-icon]');
      expect(marker?.getAttribute('aria-hidden')).toBe('true');
      expect(marker?.querySelector('svg')?.getAttribute('width')).toBe('22');
      expect(marker?.nextElementSibling?.textContent).toBe('Medium Space Name');
      expect(marker?.parentElement?.firstElementChild).toBe(marker);
      act(() =>
        window.dispatchEvent(
          new CustomEvent(RENAME_SPACE_SHORTCUT_EVENT, {
            detail: { nodeId: 'shortcut' },
          }),
        ),
      );
      expect(host.querySelector('textarea')).not.toBeNull();
      expect(host.querySelector('[data-space-type-icon]')).toBe(marker);
      expect(mocks.state.nodes[0].style?.width).toBe(360);
    },
  );

  it('shows update time but never node counts', () => {
    mocks.spaceSummaries = {
      target: { parentSpaceId: 'source', parentEntryNodeId: 'shortcut' },
    };
    render();
    expect(host.querySelector('[data-space-shortcut-summary]')).toBeNull();
    mocks.target.nodeCount = 0;
    render();
    expect(host.querySelector('[data-space-shortcut-summary]')).toBeNull();
    mocks.activity.updatedAt = Date.now();
    render();
    expect(host.querySelector('[data-space-shortcut-summary]')).not.toBeNull();
    mocks.target.status = 'missing';
    render();
    expect(host.querySelector('[data-space-shortcut-summary]')).toBeNull();
  });

  it('edits the target title with F2 event, ignores IME Enter and saves once', async () => {
    render();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(RENAME_SPACE_SHORTCUT_EVENT, {
          detail: { nodeId: 'shortcut' },
        }),
      ),
    );
    expect(host.querySelector('textarea')?.value).toBe('Research');
    const input = editTitle('Renamed');
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
        }),
      ),
    );
    expect(mocks.rename).not.toHaveBeenCalled();
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    expect(mocks.rename).toHaveBeenCalledWith('target', {
      title: 'Renamed',
      expectedTitle: 'Research',
    });
    expect(mocks.setSpaceTitle).toHaveBeenCalledWith('target', 'Renamed');
    expect(host.querySelector('textarea')).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('blocks navigation and renaming when activity refresh discovers a deleted target', () => {
    mocks.activity.status = 'missing';
    render();
    expect(
      host
        .querySelector('[data-space-shortcut]')
        ?.getAttribute('data-target-status'),
    ).toBe('missing');
    expect(host.textContent).toContain('spacePreview.missingTarget');
    expect(host.querySelector('[data-space-shortcut-summary]')).toBeNull();
    open();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(RENAME_SPACE_SHORTCUT_EVENT, {
          detail: { nodeId: 'shortcut' },
        }),
      ),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('keeps the draft and displays save failures; Escape does not save', async () => {
    mocks.rename.mockRejectedValue(new Error('offline'));
    render();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(RENAME_SPACE_SHORTCUT_EVENT, {
          detail: { nodeId: 'shortcut' },
        }),
      ),
    );
    const input = editTitle('New title');
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    expect(host.querySelector('textarea')?.value).toBe('New title');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'spacePreview.renameFailed',
    );
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('marks ordinary shortcuts after the name, not in the summary or on owned entries', () => {
    render();
    const marker = host.querySelector(
      '[data-space-shortcut] .lucide-arrow-up-right',
    );
    expect(marker?.getAttribute('aria-label')).toBe(
      'spacePreview.shortcutLabel',
    );
    expect(marker?.getAttribute('width')).toBe('1em');
    expect(marker?.previousElementSibling?.textContent).toBe('Research');
    expect(host.querySelector('[data-space-shortcut-summary]')).toBeNull();
    mocks.spaceSummaries = {
      target: { parentSpaceId: 'source', parentEntryNodeId: 'shortcut' },
    };
    render();
    expect(
      host.querySelector('[data-space-shortcut] .lucide-arrow-up-right'),
    ).toBeNull();
    mocks.spaceSummaries = {};
    mocks.state.canvasId = 'world';
    render();
    expect(
      host.querySelector('[data-space-shortcut] .lucide-arrow-up-right'),
    ).toBeNull();
  });

  it('preserves saved width even for legacy automatic cards after a rename', () => {
    render();
    expect(mocks.state.nodes[0].style?.width).toBe(360);
    mocks.target.title = 'A very long target title that cannot fit on one line';
    render();
    expect(mocks.state.nodes[0].style?.width).toBe(360);
    expect(mocks.state._setStateNoAutosave).not.toHaveBeenCalled();
  });

  it('keeps custom width across target renames', () => {
    render('fixed');
    mocks.target.title = 'Renamed Space';
    render('fixed');
    expect(mocks.state.nodes[0].style?.width).toBe(360);
    expect(mocks.state._setStateNoAutosave).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Renamed Space');
  });

  it('preserves geometry restored by history and does not fight a drag', () => {
    render();
    mocks.state.nodes[0] = { ...mocks.state.nodes[0], style: { width: 400 } };
    render();
    expect(mocks.state.nodes[0].style?.width).toBe(400);
    mocks.state.nodes[0] = {
      ...mocks.state.nodes[0],
      style: { width: 320 },
      resizing: true,
    };
    render();
    expect(mocks.state.nodes[0].style?.width).toBe(320);
    mocks.state.nodes[0] = { ...mocks.state.nodes[0], resizing: false };
    render('fixed');
    expect(mocks.state.nodes[0].style?.width).toBe(320);
  });

  it('shares navigation across double click, Enter, and toolbar', () => {
    render();
    open();
    expect(mocks.navigate.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [
        '/canvas/target',
        { state: { returnToSpace: 'source', workspaceId: 'workspace' } },
      ]),
    );
  });

  it('keeps canonical entry navigation free of return-history state', () => {
    mocks.spaceSummaries = {
      target: { parentSpaceId: 'source', parentEntryNodeId: 'shortcut' },
    };
    render();
    open();
    expect(mocks.navigate.mock.calls).toEqual(
      Array.from({ length: 3 }, () => ['/canvas/target']),
    );
  });

  it('keeps cached targets openable while surfacing background refresh errors and retry', () => {
    mocks.target.error = 'Offline';
    render();
    open();
    expect(mocks.navigate).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Offline');
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="spacePreview.retry"]')
        ?.click(),
    );
    expect(mocks.target.retry).toHaveBeenCalledOnce();
  });

  it('combines concurrent activity and metadata failures into one visible message', () => {
    mocks.target.error = 'Failed to fetch';
    mocks.activity.status = 'error';
    render();
    const messages = host.querySelectorAll('[role="status"]');
    expect(messages).toHaveLength(1);
    expect(messages[0].textContent).toBe('spacePreview.activityUnavailable');
    expect(messages[0].getAttribute('aria-label')).toBe(
      'spacePreview.activityUnavailable: Failed to fetch',
    );
    expect(host.textContent).not.toContain('Failed to fetch');
    open();
    expect(mocks.navigate).toHaveBeenCalledTimes(3);
    act(() =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="spacePreview.retry"]')
        ?.click(),
    );
    expect(mocks.target.retry).toHaveBeenCalledOnce();
    mocks.activity.status = 'ready';
    render();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Failed to fetch',
    );
    mocks.target.error = null;
    render();
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it.each(['loading', 'missing', 'error'])(
    'blocks all entry paths when %s',
    (status) => {
      mocks.target.status = status;
      render();
      open();
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(
        host.querySelector(`[data-target-status="${status}"]`),
      ).not.toBeNull();
      if (status === 'error') {
        act(() =>
          host
            .querySelector<HTMLButtonElement>(
              '[aria-label="spacePreview.retry"]',
            )
            ?.click(),
        );
        expect(mocks.target.retry).toHaveBeenCalledOnce();
      }
    },
  );
});
