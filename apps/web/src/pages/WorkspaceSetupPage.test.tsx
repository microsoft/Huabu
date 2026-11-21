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
    ] as Array<{
      workspaceId: string;
      name: string;
      path: string | null;
      active: boolean;
      canManage?: boolean;
    }>,
    removeRecentWorkspace: vi.fn(),
    activateRecentWorkspace: vi.fn(),
    selectWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    openFolderWorkspace: vi.fn(),
    renameWorkspace: vi.fn(),
    capabilities: null as null | {
      namedWorkspaces: boolean;
      folderWorkspaces: boolean;
    },
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
  mocks.state.capabilities = null;
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

it.each([false, true])(
  'offers Bubble users a Server folder only where Workspaces are folders (%s)',
  async (folderWorkspaces) => {
    mocks.state.capabilities = { namedWorkspaces: true, folderWorkspaces };
    mocks.state.openFolderWorkspace.mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <MemoryRouter>
          <WorkspaceSetupPage key="named" />
        </MemoryRouter>,
      ),
    );
    const label = [...container.querySelectorAll('label')].find(
      (element) => element.textContent === 'workspace.openFolder',
    );
    const input = label
      ? container.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`)
      : null;
    expect(input !== null).toBe(folderWorkspaces);
    expect(container.textContent).toContain('workspace.newWorkspace');
    if (!input) return;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setValue.call(input, ' /srv/notes ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    expect(mocks.state.openFolderWorkspace).toHaveBeenCalledExactlyOnceWith(
      '/srv/notes',
    );
  },
);

it('renames only the Workspaces the caller may manage', async () => {
  const original = mocks.state.recentWorkspaces;
  mocks.state.capabilities = { namedWorkspaces: true, folderWorkspaces: false };
  mocks.state.recentWorkspaces = [
    {
      workspaceId: 'mine',
      name: 'Workspace',
      path: null,
      active: true,
      canManage: true,
    },
    {
      workspaceId: 'shared',
      name: 'Shared',
      path: null,
      active: false,
      canManage: false,
    },
  ];
  mocks.state.renameWorkspace.mockResolvedValue(undefined);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <WorkspaceSetupPage key="rename" />
        </MemoryRouter>,
      ),
    );
    const pencils = container.querySelectorAll(
      'button[aria-label="workspace.renameLabel"]',
    );
    expect(pencils).toHaveLength(1);
    await act(async () => (pencils[0] as HTMLButtonElement).click());
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="workspace.renameLabel"]',
    )!;
    expect(input.value).toBe('Workspace');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, '  Default ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Enter and Escape that end an IME composition neither save nor cancel.
    for (const key of ['Enter', 'Escape'])
      await act(async () =>
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            isComposing: true,
            bubbles: true,
          }),
        ),
      );
    expect(mocks.state.renameWorkspace).not.toHaveBeenCalled();
    expect(input.isConnected).toBe(true);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
    expect(mocks.state.renameWorkspace).toHaveBeenCalledExactlyOnceWith(
      'mine',
      'Default',
    );
    expect(
      container.querySelector('input[aria-label="workspace.renameLabel"]'),
    ).toBeNull();
  } finally {
    mocks.state.recentWorkspaces = original;
  }
});

it('returns keyboard focus to Rename when the editor closes', async () => {
  const original = mocks.state.recentWorkspaces;
  mocks.state.capabilities = { namedWorkspaces: true, folderWorkspaces: false };
  mocks.state.recentWorkspaces = [
    { workspaceId: 'a', name: 'A', path: null, active: true, canManage: true },
    { workspaceId: 'b', name: 'B', path: null, active: false, canManage: true },
  ];
  mocks.state.renameWorkspace.mockResolvedValue(undefined);
  const renameButtons = () =>
    container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="workspace.renameLabel"]',
    );
  const field = () =>
    container.querySelector<HTMLInputElement>(
      'input[aria-label="workspace.renameLabel"]',
    )!;
  const press = (key: string) =>
    act(async () =>
      field().dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      ),
    );
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <WorkspaceSetupPage key="rename-focus" />
        </MemoryRouter>,
      ),
    );
    // Escape on the second row's editor puts focus back on its own Rename.
    await act(async () => renameButtons()[1]!.click());
    expect(document.activeElement).toBe(field());
    await press('Escape');
    expect(document.activeElement).toBe(renameButtons()[1]);
    // So does a successful save.
    await act(async () => renameButtons()[1]!.click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(field(), 'Renamed');
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Enter');
    expect(mocks.state.renameWorkspace).toHaveBeenCalledExactlyOnceWith(
      'b',
      'Renamed',
    );
    expect(document.activeElement).toBe(renameButtons()[1]);
  } finally {
    mocks.state.recentWorkspaces = original;
  }
});

it('offers no rename in the folder chooser', async () => {
  const original = mocks.state.recentWorkspaces;
  // A pathless Workspace the local caller may manage (SQL storage) still gets
  // no pencil here: the folder chooser knows Workspaces by their paths.
  mocks.state.recentWorkspaces = [
    {
      workspaceId: 'sql',
      name: 'Default',
      path: null,
      active: true,
      canManage: true,
    },
  ];
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <WorkspaceSetupPage key="folder-rename" />
        </MemoryRouter>,
      ),
    );
    expect(container.textContent).toContain('Default');
    expect(
      container.querySelector('button[aria-label="workspace.renameLabel"]'),
    ).toBeNull();
    // Disk Home folders keep their own chooser, not the named Workspace list.
    expect(container.textContent).toContain('workspace.folder');
    expect(container.querySelector('[role="list"]')).toBeNull();
    expect(container.textContent).not.toContain('workspace.newWorkspace');
  } finally {
    mocks.state.recentWorkspaces = original;
  }
});

it('keeps first launch as the welcome page over the shared Workspace list', async () => {
  const original = mocks.state.recentWorkspaces;
  mocks.state.capabilities = { namedWorkspaces: true, folderWorkspaces: false };
  mocks.state.recentWorkspaces = [
    {
      workspaceId: 'team',
      name: 'Team',
      path: null,
      active: false,
      canManage: false,
      role: 'viewer',
      spaceCount: 2,
    } as (typeof original)[number],
  ];
  mocks.state.activateRecentWorkspace.mockResolvedValue(undefined);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <WorkspaceSetupPage key="first-launch" />
        </MemoryRouter>,
      ),
    );
    expect(container.querySelector('h1')?.textContent).toBe(
      'workspace.welcome',
    );
    expect(container.textContent).toContain('workspace.introNamed');
    const row = container.querySelector<HTMLButtonElement>(
      '[role="listitem"] button',
    )!;
    expect(row.textContent).toContain('Team');
    expect(row.textContent).toContain('people.role.viewer');
    await act(async () => row.click());
    expect(mocks.state.activateRecentWorkspace).toHaveBeenCalledWith('team');
    // First launch announces nothing: there was no Workspace to go back to.
    expect(mocks.toast).not.toHaveBeenCalled();
  } finally {
    mocks.state.recentWorkspaces = original;
  }
});
