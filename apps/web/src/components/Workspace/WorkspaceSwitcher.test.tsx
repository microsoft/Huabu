// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOpenWorkspaceSwitcher } from './useOpenWorkspaceSwitcher';
import { WorkspaceSwitcherDialog } from './WorkspaceSwitcherDialog';
import { WorkspaceSwitcherButton } from './WorkspaceSwitcherPopover';
import {
  useWorkspaceLabel,
  useWorkspaceStore,
} from '../../store/workspaceStore';
import { useWorkspaceSwitcherUiStore } from '../../store/workspaceSwitcherUiStore';

import type { WorkspaceDescriptor, WorkspaceInfo } from '../../api/workspace';

/**
 * The quick switch, the Switch Workspace dialog and their entry point, over
 * the real Workspace store. Only the network (`api/workspace`), the toast
 * surface, the canvas save queue and the desktop bridge are replaced.
 */

const server = vi.hoisted(() => ({
  /** Every Workspace the caller may enter, as the list route answers. */
  workspaces: [] as Array<Omit<WorkspaceDescriptor, 'active'>>,
  current: '',
  calls: [] as string[],
}));
const mocks = vi.hoisted(() => ({
  toast: vi.fn((_message: string, _options?: unknown) => 'toast-id'),
  drain: vi.fn(async () => {}),
  bridge: null as null | { tabs: { context: { role: string } } },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('../Common/Toast', () => ({
  toast: mocks.toast,
  dismissToast: vi.fn(),
}));
vi.mock('../../store/canvasStore', () => ({ drainPendingSaves: mocks.drain }));
vi.mock('../../hooks/useElectron', () => ({
  getElectronBridge: () => mocks.bridge,
  requireDesktopTabSuccess: () => {},
}));
vi.mock('../../api/workspace', () => {
  const describe = () =>
    server.workspaces.map((workspace) => ({
      ...workspace,
      active: workspace.workspaceId === server.current,
    }));
  const info = (): WorkspaceInfo => {
    const current = server.workspaces.find(
      (workspace) => workspace.workspaceId === server.current,
    );
    return {
      mode: 'free',
      configured: true,
      workspaceId: server.current,
      path: null,
      name: current?.name ?? null,
      worldCanvasId: null,
      capabilities: {
        canChangeWorkspace: true,
        nativePicker: false,
        namedWorkspaces: true,
        folderWorkspaces: false,
      },
    };
  };
  return {
    listWorkspaces: vi.fn(async () => describe()),
    getWorkspaceInfo: vi.fn(async () => info()),
    activateWorkspace: vi.fn(async (workspaceId: string) => {
      server.calls.push(`activate ${workspaceId}`);
      server.current = workspaceId;
      return describe().find((w) => w.workspaceId === workspaceId);
    }),
    createNamedWorkspace: vi.fn(async (name: string) => {
      server.calls.push(`create ${name}`);
      const created = {
        workspaceId: `new-${server.workspaces.length}`,
        name,
        path: null,
        canManage: true,
        role: 'owner' as const,
        spaceCount: 0,
      };
      server.workspaces.push(created);
      return { ...created, active: false };
    }),
    renameWorkspace: vi.fn(async (workspaceId: string, name: string) => {
      server.calls.push(`rename ${workspaceId} ${name}`);
      const workspace = server.workspaces.find(
        (w) => w.workspaceId === workspaceId,
      )!;
      workspace.name = name;
      return { ...workspace, active: workspaceId === server.current };
    }),
    openFolderWorkspace: vi.fn(),
    putWorkspacePath: vi.fn(),
    removeWorkspace: vi.fn(),
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT = {
  workspaceId: 'default',
  name: 'Default',
  path: null,
  canManage: false,
  role: 'editor' as const,
  spaceCount: 3,
};
const LAB = {
  workspaceId: 'lab',
  name: 'Research lab',
  path: null,
  canManage: true,
  role: 'owner' as const,
  spaceCount: 14,
};

let root: Root;
let container: HTMLDivElement;
let path = '';

function Probe() {
  path = useLocation().pathname;
  return null;
}
function Header() {
  const label = useWorkspaceLabel() ?? '';
  return (
    <WorkspaceSwitcherButton label={label}>
      <span data-testid="label">{label}</span>
    </WorkspaceSwitcherButton>
  );
}
function MenuItem() {
  const open = useOpenWorkspaceSwitcher();
  return (
    <button type="button" onClick={() => open()}>
      Menu: Switch Workspace
    </button>
  );
}

async function mount(entry = '/spaces') {
  const named = server.workspaces.length > 0;
  useWorkspaceStore.setState({
    mode: 'free',
    capabilities: {
      canChangeWorkspace: true,
      nativePicker: false,
      namedWorkspaces: named,
      folderWorkspaces: false,
    },
    workspaceId: server.current,
    workspaceName:
      server.workspaces.find((w) => w.workspaceId === server.current)?.name ??
      null,
    workspacePath: null,
    recentWorkspaces: server.workspaces.map((workspace) => ({
      ...workspace,
      active: workspace.workspaceId === server.current,
    })),
    isReady: true,
    isSyncing: false,
    error: null,
  });
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Header />
        <MenuItem />
        <WorkspaceSwitcherDialog />
        <Probe />
      </MemoryRouter>,
    ),
  );
}

const label = () =>
  document.querySelector('[data-testid="label"]')?.textContent;
const trigger = () =>
  document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
const buttonNamed = (text: string | RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    typeof text === 'string'
      ? button.textContent?.trim() === text ||
        button.getAttribute('aria-label') === text
      : text.test(button.textContent ?? ''),
  );
const dialog = () => document.querySelector('[role="dialog"]');
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};
const key = async (name: string, target: EventTarget = window) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true }),
    );
  });
const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
/** Let the popover arm its outside-press listener (it waits one tick). */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  server.workspaces = [structuredClone(DEFAULT), structuredClone(LAB)];
  server.current = 'default';
  server.calls = [];
  mocks.bridge = null;
  vi.clearAllMocks();
  useWorkspaceSwitcherUiStore.getState().close();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('quick switch popover', () => {
  it('lists each Workspace with role and Space count, and marks the current one', async () => {
    await mount();
    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const rows = [...dialog()!.querySelectorAll('[role="listitem"]')];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Default'),
      expect.stringContaining('Research lab'),
    ]);
    expect(rows[0].textContent).toContain(
      'people.role.editor · canvasList.canvasCount {"count":3}',
    );
    expect(rows[0].querySelector('[aria-current="true"]')).not.toBeNull();
    // Rename only where the caller may manage the Workspace.
    expect(
      rows[0].querySelector('button[aria-label^="workspace.renameLabel"]'),
    ).toBeNull();
    expect(
      rows[1].querySelector('button[aria-label^="workspace.renameLabel"]'),
    ).not.toBeNull();
    expect(buttonNamed('workspace.newWorkspaceEllipsis')).toBeTruthy();
    expect(buttonNamed('workspace.allWorkspaces')).toBeTruthy();
  });

  it('cancels with Escape or a click outside, changing nothing', async () => {
    await mount();
    await click(trigger());
    await settle();
    await key('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());

    await click(trigger());
    await settle();
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
    expect(server.calls).toEqual([]);
    expect(label()).toBe('Default');
    expect(path).toBe('/spaces');
  });

  it('switches at once, names the new Workspace, and offers the way back', async () => {
    await mount();
    await click(trigger());
    await click(buttonNamed(/Research lab/));

    expect(server.calls).toEqual(['activate lab']);
    expect(label()).toBe('Research lab');
    expect(useWorkspaceStore.getState().workspaceId).toBe('lab');
    expect(dialog()).toBeNull();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const [message, options] = mocks.toast.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe(
      'workspace.switchedCount {"workspace":"Research lab","count":14}',
    );
    expect(options.action.label).toBe(
      'workspace.backTo {"workspace":"Default"}',
    );

    await act(async () => options.action.onClick());
    expect(server.calls).toEqual(['activate lab', 'activate default']);
    expect(label()).toBe('Default');
  });

  it('closes without switching when the current Workspace is chosen', async () => {
    await mount();
    await click(trigger());
    await click(buttonNamed(/^DDefault/));
    expect(dialog()).toBeNull();
    expect(server.calls).toEqual([]);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('renames a Workspace in place, and Escape cancels only the rename', async () => {
    await mount();
    await click(trigger());
    await click(
      document.querySelector(
        'button[aria-label^="workspace.renameLabel"][aria-label*="Research lab"]',
      ),
    );
    const field = () =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label^="workspace.renameLabel"]',
      );
    await key('Escape', field()!);
    expect(field()).toBeNull();
    expect(dialog()).not.toBeNull();

    await click(
      document.querySelector(
        'button[aria-label^="workspace.renameLabel"][aria-label*="Research lab"]',
      ),
    );
    await type(field()!, 'Lab notes');
    await key('Enter', field()!);
    expect(server.calls).toEqual(['rename lab Lab notes']);
    expect(dialog()?.textContent).toContain('Lab notes');
    // Renaming is not switching.
    expect(label()).toBe('Default');
  });

  it('hands over to the dialog for creating or seeing all Workspaces', async () => {
    await mount();
    await click(trigger());
    await click(buttonNamed('workspace.newWorkspaceEllipsis'));
    expect(useWorkspaceSwitcherUiStore.getState()).toMatchObject({
      isOpen: true,
      intent: 'create',
    });
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
  });

  it('becomes a bottom sheet with Cancel at phone width', async () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query.includes('max-width: 639px'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    try {
      await mount();
      await click(trigger());
      expect(dialog()?.getAttribute('aria-modal')).toBe('true');
      expect(dialog()?.className).toContain('self-end');
      await click(buttonNamed('actions.cancel'));
      expect(dialog()).toBeNull();
      expect(server.calls).toEqual([]);
    } finally {
      matchMedia.mockRestore();
    }
  });
});

describe('Switch Workspace dialog', () => {
  const open = async () => click(buttonNamed('Menu: Switch Workspace'));

  it('opens from the menu entry and cancels with Cancel or Escape', async () => {
    await mount();
    await open();
    expect(dialog()?.textContent).toContain(
      'workspace.dialogIntro {"workspace":"Default"}',
    );
    // Nothing to switch to until another Workspace is marked.
    expect(buttonNamed('workspace.switch')?.disabled).toBe(true);
    await click(buttonNamed('actions.cancel'));
    expect(dialog()).toBeNull();

    await open();
    await key('Escape');
    expect(dialog()).toBeNull();
    expect(server.calls).toEqual([]);
    expect(path).toBe('/spaces');
  });

  it('switches to the marked Workspace with the Switch button', async () => {
    await mount();
    await open();
    const lab = document.querySelector<HTMLInputElement>(
      'input[type="radio"][value="lab"]',
    )!;
    await act(async () => lab.click());
    expect(server.calls).toEqual([]);
    await click(buttonNamed('workspace.switchTo {"workspace":"Research lab"}'));
    expect(dialog()).toBeNull();
    expect(server.calls).toEqual(['activate lab']);
    expect(label()).toBe('Research lab');
  });

  it('saves an open Space and leaves it before switching', async () => {
    await mount('/canvas/space-in-default');
    await open();
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[type="radio"][value="lab"]')!
        .click(),
    );
    await click(buttonNamed('workspace.switchTo {"workspace":"Research lab"}'));
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    expect(path).toBe('/');
    expect(server.calls).toEqual(['activate lab']);
  });

  it('stays put when the open Space cannot be saved', async () => {
    mocks.drain.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount('/canvas/space-in-default');
    await open();
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[type="radio"][value="lab"]')!
        .click(),
    );
    await click(buttonNamed('workspace.switchTo {"workspace":"Research lab"}'));
    expect(server.calls).toEqual([]);
    expect(path).toBe('/canvas/space-in-default');
    expect(mocks.toast).toHaveBeenCalledWith('workspace.unsavedBeforeSwitch', {
      tone: 'danger',
    });
  });

  it('creates a Workspace and switches to it', async () => {
    await mount();
    await open();
    const name = [...document.querySelectorAll('label')].find(
      (label) => label.textContent === 'workspace.newWorkspace',
    )!;
    const input = document.querySelector<HTMLInputElement>(
      `[id="${name.htmlFor}"]`,
    )!;
    await type(input, 'Side project');
    await click(buttonNamed('workspace.create'));
    expect(server.calls).toEqual(['create Side project', 'activate new-2']);
    expect(label()).toBe('Side project');
    expect(dialog()).toBeNull();
    expect(mocks.toast.mock.calls[0][0]).toBe(
      'workspace.switchedCount {"workspace":"Side project","count":0}',
    );
  });
});

describe('a server without roles or Space counts', () => {
  it('shows names alone and announces a switch without a count', async () => {
    server.workspaces = [DEFAULT, LAB].map(
      ({ role: _role, spaceCount: _count, ...rest }) => rest,
    );
    await mount();
    await click(trigger());
    const rows = [...dialog()!.querySelectorAll('[role="listitem"]')];
    expect(rows[0].textContent).not.toContain('people.role');
    expect(rows[0].textContent).not.toContain('canvasCount');
    await click(buttonNamed(/Research lab/));
    expect(mocks.toast.mock.calls[0][0]).toBe(
      'workspace.switched {"workspace":"Research lab"}',
    );

    await click(buttonNamed('Menu: Switch Workspace'));
    // Who owns a new Workspace is only said where there are roles.
    expect(dialog()?.textContent).not.toContain('workspace.createHint');
  });
});

describe('entry points', () => {
  it('keeps the folder chooser for Disk Home folders', async () => {
    server.workspaces = [];
    await mount();
    await click(buttonNamed('Menu: Switch Workspace'));
    expect(path).toBe('/setup');
    expect(dialog()).toBeNull();
  });

  it('asks Home to open the dialog from a desktop Space tab', async () => {
    mocks.bridge = { tabs: { context: { role: 'space' } } };
    await mount('/canvas/a');
    await click(buttonNamed('Menu: Switch Workspace'));
    // The navigation carries the request; Home (the same component here)
    // opens the dialog and clears it.
    expect(path).toBe('/spaces');
    expect(useWorkspaceSwitcherUiStore.getState().isOpen).toBe(true);
  });
});
