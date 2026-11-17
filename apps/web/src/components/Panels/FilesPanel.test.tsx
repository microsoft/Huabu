// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { usePanelStore } from '@/store/panelStore';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { FilesPanel } from './FilesPanel';

import type { FileListResult } from '@huabu/shared';
import type * as ReactI18next from 'react-i18next';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  preview: vi.fn(),
  add: vi.fn(),
  copy: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('@/api/device-files', () => ({ listDeviceFiles: mocks.list }));
vi.mock('@/store/previewWorkspace/actions', () => ({
  openPreviewFile: mocks.preview,
}));
vi.mock('@/components/Common/Loading', () => ({ Loading: () => null }));
vi.mock('@/utils/io/clipboard', () => ({ copyToClipboard: mocks.copy }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: mocks.t }),
}));
vi.mock('react-virtuoso', () => ({
  Virtuoso: <T,>({
    data,
    itemContent,
  }: {
    data: T[];
    itemContent: (index: number, row: T) => ReactNode;
  }) => (
    <div>
      {data.map((row, index) => (
        <div key={index}>{itemContent(index, row)}</div>
      ))}
    </div>
  ),
}));
let host: HTMLDivElement;
let root: Root;
const page = (
  entries: FileListResult['entries'],
  nextCursor?: string,
): FileListResult => ({
  path: '/root',
  parentPath: '/',
  entries,
  ...(nextCursor ? { nextCursor } : {}),
});
const file = {
  name: 'file.txt',
  path: '/root/file.txt',
  kind: 'file' as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.copy.mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useCanvasStore.setState({ canvasId: 'canvas-files', addNode: mocks.add });
  usePanelStore.getState().openFiles({
    canvasId: 'canvas-files',
    agentletId: 'device',
    path: '/root',
  });
  useAcpProfilesStore.setState({
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    connectedDevices: [
      {
        agentletId: 'device',
        displayName: 'Remote',
        connectedAt: '',
        version: '1',
        profileCount: 0,
      },
    ],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const click = async (label: string) => {
  const found = [...host.querySelectorAll('button')].find(
    (button) =>
      button.textContent === label ||
      button.title === label ||
      button.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  await act(async () => found.click());
};

it('loads directories lazily, deduplicates mutation-overlapping pages and creates metadata-only cards', async () => {
  mocks.list
    .mockResolvedValueOnce(
      page(
        [{ name: 'folder', path: '/root/folder', kind: 'directory' }, file],
        'page2',
      ),
    )
    .mockResolvedValueOnce(page([file]))
    .mockResolvedValueOnce(page([]));
  await act(async () => root.render(<FilesPanel />));
  expect(mocks.list).toHaveBeenCalledOnce();
  await click('files.more');
  expect(host.textContent?.match(/file.txt/g)).toHaveLength(1);
  await click('folder');
  expect(mocks.list.mock.calls.at(-1)?.[1]).toEqual({
    path: '/root/folder',
    showHidden: false,
  });
  // A file opens in Preview on click; nothing lands on the canvas for it.
  await click('file.txt');
  expect(mocks.preview).toHaveBeenCalledWith({
    agentletId: 'device',
    path: '/root/file.txt',
    deviceName: 'Remote',
  });
  expect(mocks.add).not.toHaveBeenCalled();
  await openMenu('file.txt');
  const addItem = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((element) => element.textContent === 'files.addToCanvas');
  if (!addItem) throw new Error('Missing add to canvas');
  await act(async () => addItem.click());
  expect(mocks.add).toHaveBeenCalledWith(
    expect.objectContaining({
      nodeType: 'fileReference',
      data: {
        label: 'file.txt',
        origin: { type: 'user-created' },
        fileReference: {
          agentletId: 'device',
          path: '/root/file.txt',
          deviceName: 'Remote',
        },
      },
    }),
  );
  usePanelStore.getState().requestFocusCanvasSearch();
  expect(usePanelStore.getState().leftMode).toBe('layers');
});

it('discards late directory replies after the browsing target changes', async () => {
  let resolve!: (value: FileListResult) => void;
  mocks.list
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ path: '/new', parentPath: '/', entries: [] });
  await act(async () => root.render(<FilesPanel />));
  const signal = mocks.list.mock.calls[0]?.[2] as AbortSignal;
  await act(async () =>
    usePanelStore.getState().openFiles({
      canvasId: 'canvas-files',
      agentletId: 'device',
      path: '/new',
    }),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(page([file])));
  expect(host.textContent).not.toContain('file.txt');
});

function rowFor(name: string) {
  const row = [...host.querySelectorAll<HTMLElement>('[role="group"]')].find(
    (element) => element.getAttribute('aria-label') === name,
  );
  if (!row) throw new Error(`Missing row ${name}`);
  return row;
}

async function openMenu(name: string) {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 80,
    clientY: 120,
  });
  const row = rowFor(name);
  const target = row.querySelector('span[title], button') ?? row;
  await act(async () => target.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
}

async function selectCopy(label: string, value: string) {
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((element) => element.textContent === label);
  if (!item) throw new Error(`Missing menu item ${label}`);
  await act(async () => item.click());
  expect(mocks.copy).toHaveBeenLastCalledWith(value);
  expect(document.querySelector('[role="menu"]')).toBeNull();
}

it('replaces native row menus with three metadata copy actions but retains native input menus', async () => {
  const folder = {
    name: 'folder',
    path: '/root/folder',
    kind: 'directory' as const,
  };
  mocks.list.mockResolvedValueOnce(page([folder, file]));
  await act(async () => root.render(<FilesPanel />));
  for (const entry of [folder, file]) {
    await openMenu(entry.name);
    const menuItem = document.querySelector('[role="menuitem"]');
    if (!menuItem) throw new Error('Missing copy action');
    const menuContext = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => menuItem.dispatchEvent(menuContext));
    expect(menuContext.defaultPrevented).toBe(true);
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual([
      ...(entry.kind === 'file' ? ['files.addToCanvas'] : []),
      'files.copyName',
      'files.copyRelativePath',
      'files.copyFullPath',
    ]);
    await selectCopy('files.copyName', entry.name);
    await openMenu(entry.name);
    await selectCopy('files.copyRelativePath', entry.name);
    await openMenu(entry.name);
    await selectCopy('files.copyFullPath', entry.path);
  }
  const input = host.querySelector('input[aria-label="files.path"]');
  if (!input) throw new Error('Missing path input');
  const nativeMenu = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
  });
  await act(async () => input.dispatchEvent(nativeMenu));
  expect(nativeMenu.defaultPrevented).toBe(false);
  expect(mocks.list).toHaveBeenCalledOnce();
  expect(mocks.add).not.toHaveBeenCalled();
});

it.each([
  {
    source: '/alias',
    canonicalRoot: '/actual-root',
    folderPath: '/actual-root/link dir',
    canonicalChild: '/outside',
    filePath: '/outside/报告 $x.txt',
    relative: 'link dir/报告 $x.txt',
  },
  {
    source: '/root',
    canonicalRoot: '/root',
    folderPath: '/root/link dir',
    canonicalChild: '/root/link dir',
    filePath: '/root/link dir/back\\slash.txt',
    relative: 'link dir/back\\slash.txt',
  },
  {
    source: 'C:/root',
    canonicalRoot: 'C:\\root',
    folderPath: 'C:\\root\\link dir',
    canonicalChild: 'D:\\outside',
    filePath: 'D:\\outside\\报告 $x.txt',
    relative: 'link dir\\报告 $x.txt',
  },
  {
    source: '\\\\host\\share',
    canonicalRoot: '\\\\host\\share\\',
    folderPath: '\\\\host\\share\\link dir',
    canonicalChild: '\\\\other\\share',
    filePath: '\\\\other\\share\\报告 $x.txt',
    relative: 'link dir\\报告 $x.txt',
  },
])(
  'copies nested displayed paths using the device separator at $source',
  async (scenario) => {
    const name = scenario.filePath.endsWith('back\\slash.txt')
      ? 'back\\slash.txt'
      : '报告 $x.txt';
    usePanelStore.getState().openFiles({
      canvasId: 'canvas-files',
      agentletId: 'device',
      path: scenario.source,
    });
    mocks.list
      .mockResolvedValueOnce({
        path: scenario.canonicalRoot,
        parentPath: scenario.canonicalRoot,
        entries: [
          { name: 'link dir', path: scenario.folderPath, kind: 'directory' },
        ],
      })
      .mockResolvedValueOnce({
        path: scenario.canonicalChild,
        parentPath: scenario.canonicalChild,
        entries: [{ name, path: scenario.filePath, kind: 'file' }],
      });
    await act(async () => root.render(<FilesPanel />));
    await click('link dir');
    expect(
      rowFor('link dir').querySelector('button')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await openMenu(name);
    await selectCopy('files.copyRelativePath', scenario.relative);
    await openMenu(name);
    await selectCopy('files.copyFullPath', scenario.filePath);
    await openMenu(name);
    await selectCopy('files.copyName', name);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  },
);

it('supports keyboard opening, Escape and outside dismissal, and reports clipboard failures', async () => {
  mocks.list.mockResolvedValueOnce(page([file]));
  await act(async () => root.render(<FilesPanel />));
  const trigger = rowFor(file.name).querySelector<HTMLElement>(
    '[aria-haspopup="menu"]',
  );
  if (!trigger) throw new Error('Missing actions trigger');
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'F10',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => {
    const first = document.querySelector<HTMLElement>('[role="menuitem"]');
    first?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  // The file menu now leads with Add to Canvas, so one step down is Copy name.
  expect(document.activeElement?.textContent).toBe('files.copyName');
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    ),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(
    async () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(document.activeElement).toBe(trigger);
  await openMenu(file.name);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () =>
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    ),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  mocks.copy.mockRejectedValueOnce(new Error('Clipboard denied'));
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ContextMenu',
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await selectCopy('files.copyFullPath', file.path);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    'files.copyFailed',
  );
  await openMenu(file.name);
  await selectCopy('files.copyFullPath', file.path);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => trigger.click());
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await selectCopy('files.copyName', file.name);
});

it('preserves file dragging and retires the menu when the browsing root changes', async () => {
  mocks.list
    .mockResolvedValueOnce(page([file]))
    .mockResolvedValueOnce(page([]));
  await act(async () => root.render(<FilesPanel />));
  const draggable = rowFor(file.name).querySelector('[draggable="true"]');
  if (!draggable) throw new Error('Missing draggable file');
  const dataTransfer = { effectAllowed: '', setData: vi.fn() };
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  await act(async () => draggable.dispatchEvent(event));
  expect(dataTransfer.effectAllowed).toBe('copy');
  const payload = dataTransfer.setData.mock.calls.find(
    ([mime]) => mime === 'application/x-huabu-dnd',
  )?.[1];
  expect(JSON.parse(payload)).toMatchObject({
    kind: 'fileReference',
    data: {
      label: file.name,
      fileReference: {
        agentletId: 'device',
        path: file.path,
        deviceName: 'Remote',
      },
    },
  });
  await openMenu(file.name);
  await act(async () =>
    usePanelStore.getState().openFiles({
      canvasId: 'canvas-files',
      agentletId: 'device',
      path: '/new',
    }),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('keeps the listing and open folders on screen while refreshing, and loads folders independently', async () => {
  const folder = (name: string) => ({
    name,
    path: `/root/${name}`,
    kind: 'directory' as const,
  });
  const pendingReplies: Array<(value: FileListResult) => void> = [];
  const deferred = () =>
    new Promise<FileListResult>((done) => {
      pendingReplies.push(done);
    });
  mocks.list
    .mockResolvedValueOnce(page([folder('a'), folder('b')]))
    .mockImplementationOnce(deferred)
    .mockImplementationOnce(deferred);
  await act(async () => root.render(<FilesPanel />));

  // Two folders load at once; neither disables the other or adds a banner.
  await click('a');
  await click('b');
  expect(mocks.list).toHaveBeenCalledTimes(3);
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('button[disabled]')).toBeNull();
  await act(async () => pendingReplies[0]?.(page([file])));
  await act(async () => pendingReplies[1]?.(page([])));
  expect(host.textContent).toContain('file.txt');

  // Refresh re-lists the root and both open folders without blanking.
  pendingReplies.length = 0;
  mocks.list.mockImplementation(deferred);
  await click('files.refresh');
  expect(mocks.list.mock.calls.slice(3).map((call) => call[1].path)).toEqual([
    '/root',
    '/root/a',
    '/root/b',
  ]);
  expect(host.textContent).toContain('file.txt');
  expect(host.querySelector('[role="status"]')).toBeNull();
  await act(async () => {
    pendingReplies[0]?.(page([folder('a')]));
    pendingReplies[1]?.(page([{ ...file, name: 'fresh.txt' }]));
    pendingReplies[2]?.(page([]));
  });
  expect(host.textContent).toContain('fresh.txt');
  expect(host.textContent).not.toContain('file.txt');
  expect(
    rowFor('a').querySelector('button')?.getAttribute('aria-expanded'),
  ).toBe('true');
  expect(() => rowFor('b')).toThrow();
});

it('starts browsing without a typed path: the remembered directory, else the device root', async () => {
  usePanelStore.setState({ filesLocation: null, filesLastPaths: {} });
  mocks.list.mockResolvedValue(page([]));
  await act(async () => root.render(<FilesPanel />));
  expect(mocks.list.mock.calls.at(-1)?.[1].path).toBe('/');
  expect(usePanelStore.getState().filesLocation).toMatchObject({
    agentletId: 'device',
    path: '/',
  });

  await act(async () =>
    usePanelStore.getState().openFiles({
      canvasId: 'canvas-files',
      agentletId: 'device',
      path: '/projects',
    }),
  );
  await act(async () => usePanelStore.setState({ filesLocation: null }));
  expect(usePanelStore.getState().filesLocation?.path).toBe('/projects');
});

it('falls back to the device root when the remembered directory can no longer be listed', async () => {
  usePanelStore.setState({
    filesLocation: null,
    filesLastPaths: { 'canvas-files\ndevice': '/gone' },
  });
  mocks.list
    .mockRejectedValueOnce(new Error('ENOENT'))
    .mockResolvedValueOnce(page([file]));
  await act(async () => root.render(<FilesPanel />));
  expect(mocks.list.mock.calls.map((call) => call[1].path)).toEqual([
    '/gone',
    '/',
  ]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('file.txt');
});

it('highlights the file open in Preview', async () => {
  mocks.list.mockResolvedValueOnce(page([file]));
  await act(async () => root.render(<FilesPanel />));
  const preview = usePreviewWorkspaceStore.getState();
  const before = preview.workspace;
  try {
    await act(async () => {
      usePreviewWorkspaceStore.setState({ canvasId: 'canvas-files' });
      usePreviewWorkspaceStore.getState().openPreviewTarget({
        kind: 'file',
        canvasId: 'canvas-files',
        agentletId: 'device',
        path: file.path,
      });
    });
    expect(
      rowFor(file.name).querySelector('button')?.getAttribute('aria-current'),
    ).toBe('true');
  } finally {
    usePreviewWorkspaceStore.setState({ workspace: before });
  }
});
