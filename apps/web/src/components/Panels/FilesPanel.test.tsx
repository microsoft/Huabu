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
  t: (key: string) => key,
}));
vi.mock('@/api/device-files', () => ({ listDeviceFiles: mocks.list }));
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
