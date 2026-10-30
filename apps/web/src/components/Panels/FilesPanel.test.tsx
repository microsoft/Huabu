// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { usePanelStore } from '@/store/panelStore';

import { FilesPanel } from './FilesPanel';

import type { FileListResult } from '@huabu/shared';
import type * as ReactI18next from 'react-i18next';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  copy: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('@/api/device-files', () => ({ listDeviceFiles: mocks.list }));
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
  await click('files.add');
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
  expect(document.activeElement?.textContent).toBe('files.copyRelativePath');
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
