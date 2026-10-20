// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import WorkspaceSetupPage from './WorkspaceSetupPage';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  state: {
    mode: 'free',
    isSyncing: false,
    error: null as string | null,
    recentWorkspaces: [
      {
        workspaceId: 'second',
        name: 'Second',
        path: '/tmp/second',
        active: false,
      },
    ],
    removeRecentWorkspace: vi.fn(),
    activateRecentWorkspace: vi.fn(),
    selectWorkspace: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../components/Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('./WorkspaceLoadingScreen', () => ({
  WorkspaceLoadingScreen: () => null,
}));
vi.mock('../components/Common/PathInput', () => ({
  PathInput: ({ onPicked }: { onPicked: (path: string) => void }) => (
    <button onClick={() => onPicked('/tmp/second')}>Pick folder</button>
  ),
}));
vi.mock('../store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (select: (state: typeof mocks.state) => unknown) => select(mocks.state),
    { getState: () => mocks.state },
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.state.error = null;
  for (const action of [
    mocks.state.selectWorkspace,
    mocks.state.activateRecentWorkspace,
  ])
    action.mockImplementation(async () => {
      mocks.state.error = 'Background Space could not save';
      throw new Error(mocks.state.error);
    });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <WorkspaceSetupPage />
      </MemoryRouter>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it.each(['Pick folder', '/tmp/second'])(
  'shows the latest Store failure in a danger toast after selecting %s',
  async (label) => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
      'Background Space could not save',
      { tone: 'danger' },
    );
  },
);
