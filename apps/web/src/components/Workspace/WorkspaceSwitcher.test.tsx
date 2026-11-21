// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPEN_WORKSPACE_SWITCHER,
  useOpenWorkspaceSwitcher,
} from './useOpenWorkspaceSwitcher';
import { WorkspaceLanding } from './WorkspaceLanding';
import { WorkspaceSwitcherDialog } from './WorkspaceSwitcherDialog';
import { WorkspaceSwitcherButton } from './WorkspaceSwitcherPopover';
import {
  useWorkspaceLabel,
  useWorkspaceStore,
} from '../../store/workspaceStore';
import { useWorkspaceSwitcherUiStore } from '../../store/workspaceSwitcherUiStore';
import { dismissToast } from '../Common/Toast';
import { DesktopHomeMenu } from '../Shell/DesktopHomeMenu';
import { SpaceNavigationGuard } from '../Space/SpaceNavigationGuard';

import type { WorkspaceDescriptor, WorkspaceInfo } from '../../api/workspace';

/**
 * The quick switch, the Switch Workspace dialog and their entry points, over
 * the real Workspace store, the real Space navigation guard and the real `/`
 * landing. Only the network (`api/workspace`), the toast surface, the canvas
 * save queues and the desktop bridge are replaced.
 */

const server = vi.hoisted(() => ({
  /** Every Workspace the caller may enter, as the list route answers. */
  workspaces: [] as Array<Omit<WorkspaceDescriptor, 'active'>>,
  current: '',
  calls: [] as string[],
  /** The route the app showed when each activation reached the Server. */
  pathsAtActivation: [] as string[],
  /** The route the app shows now, as `Probe` last saw it. */
  path: '',
  /** Each Workspace's World Space id, when the test turns World on. */
  worlds: {} as Record<string, string>,
  /** Makes the next create request fail, as a Server error would. */
  failCreate: false,
  /**
   * Makes activation requests fail: `'before'` leaves the current Workspace
   * as it was; `'after'` switches it but loses the answer.
   */
  failActivate: null as null | 'before' | 'after',
  /** Makes list requests fail. */
  failList: false,
  /** Makes the next create's answer get lost after the Server made it. */
  loseCreateAnswer: false,
  /** The `requestId` each create request carried, in order. */
  createRequestIds: [] as Array<string | undefined>,
  /** The Workspace each `requestId` made, as the Server replays them. */
  createdByRequest: {} as Record<string, string>,
}));
const mocks = vi.hoisted(() => ({
  toast: vi.fn((_message: string, _options?: unknown) => 'toast-id'),
  /** `savedBeforeLeaving`: everything the page owes the Server, saved. */
  saved: vi.fn(async () => true),
  /** The Space navigation guard's own drain as the person leaves a Space. */
  drain: vi.fn(async (_canvasId?: string | null) => {}),
  bridge: null as null | {
    tabs: {
      context: { role: string };
      open?: (target: unknown) => Promise<unknown>;
      onHomeMenu?: (
        listener: (position: { x: number } | null) => void,
      ) => () => void;
      command?: (command: unknown) => Promise<unknown>;
      beginWorkspaceChange?: () => Promise<unknown>;
      endWorkspaceChange?: () => Promise<unknown>;
      workspaceReady?: (workspaceId: string) => Promise<unknown>;
    };
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('@/i18n', () => ({
  i18n: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  },
}));
// The guard's saving overlay animates with lottie, which jsdom cannot draw.
vi.mock('@/components/Common/Loading', () => ({ Loading: () => null }));
vi.mock('../Common/Toast', () => ({
  toast: mocks.toast,
  dismissToast: vi.fn(),
}));
vi.mock('../../store/canvasStore', () => ({
  default: { getState: () => ({ canvasId: 'open-space' }) },
  savedBeforeLeaving: mocks.saved,
  drainPendingSaves: mocks.drain,
  discardPendingSaves: vi.fn(async () => {}),
}));
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
      worldCanvasId: server.worlds[server.current] ?? null,
      capabilities: {
        canChangeWorkspace: true,
        nativePicker: false,
        namedWorkspaces: true,
        folderWorkspaces: false,
      },
    };
  };
  return {
    listWorkspaces: vi.fn(async () => {
      if (server.failList) throw new Error('List unavailable');
      return describe();
    }),
    getWorkspaceInfo: vi.fn(async () => info()),
    activateWorkspace: vi.fn(async (workspaceId: string) => {
      server.calls.push(`activate ${workspaceId}`);
      server.pathsAtActivation.push(server.path);
      if (server.failActivate === 'before')
        throw new Error('Activation failed');
      server.current = workspaceId;
      if (server.failActivate === 'after') throw new Error('Answer lost');
      return describe().find((w) => w.workspaceId === workspaceId);
    }),
    createNamedWorkspace: vi.fn(async (name: string, requestId?: string) => {
      server.calls.push(`create ${name}`);
      server.createRequestIds.push(requestId);
      if (server.failCreate) throw new Error('Service unavailable');
      const replayed = requestId && server.createdByRequest[requestId];
      const earlier = describe().find((w) => w.workspaceId === replayed);
      if (replayed && earlier) return earlier;
      const created = {
        workspaceId: `new-${server.workspaces.length}`,
        name,
        path: null,
        canManage: true,
        role: 'owner' as const,
        spaceCount: 0,
      };
      server.workspaces.push(created);
      if (requestId) server.createdByRequest[requestId] = created.workspaceId;
      if (server.loseCreateAnswer) {
        server.loseCreateAnswer = false;
        throw new Error('Answer lost');
      }
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
  server.path = path;
  return null;
}
/** Opens a Space the way a link in the app would. */
function OpenSpace() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/canvas/space-in-lab')}>
      Open a Space
    </button>
  );
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

async function mount(
  entry: string | { pathname: string; state: unknown } = '/spaces',
) {
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
    worldCanvasId: server.worlds[server.current] ?? null,
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
      // A data router, as in the app, so the real Space navigation guard can
      // hold a departure from a Space.
      <RouterProvider
        router={createMemoryRouter(
          [
            {
              path: '/',
              element: (
                <>
                  <Header />
                  <MenuItem />
                  <OpenSpace />
                  {mocks.bridge?.tabs.onHomeMenu && <DesktopHomeMenu />}
                  <WorkspaceSwitcherDialog />
                  <SpaceNavigationGuard />
                  <Probe />
                  <Outlet />
                </>
              ),
              children: [
                // The app's own landing: World when it is on, else Spaces.
                { index: true, element: <WorkspaceLanding /> },
                { path: '*', element: null },
              ],
            },
          ],
          { initialEntries: [entry] },
        )}
      />,
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
  server.pathsAtActivation = [];
  server.worlds = {};
  server.failCreate = false;
  server.failActivate = null;
  server.failList = false;
  server.loseCreateAnswer = false;
  server.createRequestIds = [];
  server.createdByRequest = {};
  mocks.bridge = null;
  useWorkspaceStore.setState({ worldEnabled: false });
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

  it('saves and leaves a Space opened after the switch before going back from the toast', async () => {
    await mount();
    await click(trigger());
    await click(buttonNamed(/Research lab/));
    const [, options] = mocks.toast.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    // The popover that made the toast is gone; the person opens a Space in
    // the new Workspace before pressing Back.
    await click(buttonNamed('Open a Space'));
    expect(path).toBe('/canvas/space-in-lab');
    expect(mocks.drain).not.toHaveBeenCalled();

    await act(async () => options.action.onClick());
    expect(mocks.saved).toHaveBeenCalledTimes(2);
    // The guard drained the Space on the way out, before activation.
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    expect(path).toBe('/spaces');
    expect(server.calls).toEqual(['activate lab', 'activate default']);
    expect(server.pathsAtActivation).toEqual(['/spaces', '/spaces']);
  });

  it('keeps a rename made while the list was being refreshed', async () => {
    const api = await import('../../api/workspace');
    let answer: () => void = () => {};
    vi.mocked(api.listWorkspaces).mockImplementationOnce(async () => {
      // The list as it stood when the chooser opened, answered late.
      const stale = server.workspaces.map((workspace) => ({
        ...structuredClone(workspace),
        active: workspace.workspaceId === server.current,
      }));
      await new Promise<void>((resolve) => (answer = resolve));
      return stale;
    });
    await mount();
    await click(trigger());
    await act(async () =>
      useWorkspaceStore.getState().renameWorkspace('lab', 'Lab notes'),
    );
    await act(async () => answer());
    expect(
      useWorkspaceStore
        .getState()
        .recentWorkspaces.find((workspace) => workspace.workspaceId === 'lab')
        ?.name,
    ).toBe('Lab notes');
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
  const nameField = () => {
    const name = [...document.querySelectorAll('label')].find(
      (label) => label.textContent === 'workspace.newWorkspace',
    );
    const field = document.querySelector<HTMLInputElement>(
      `[id="${name?.htmlFor}"]`,
    );
    if (!field) throw new Error('No name field');
    return field;
  };

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

  it('counts a switch the Server made as done when its answer is lost', async () => {
    server.failActivate = 'after';
    await mount();
    await open();
    await click(document.querySelector('input[type="radio"][value="lab"]'));
    await click(buttonNamed('workspace.switchTo {"workspace":"Research lab"}'));
    expect(label()).toBe('Research lab');
    expect(useWorkspaceStore.getState().error).toBeNull();
    expect(mocks.toast.mock.calls[0][0]).toBe(
      'workspace.switchedCount {"workspace":"Research lab","count":14}',
    );
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
    expect(mocks.saved).toHaveBeenCalledTimes(1);
    expect(mocks.drain).toHaveBeenCalledWith('open-space');
    expect(path).toBe('/spaces');
    expect(server.calls).toEqual(['activate lab']);
    // The Workspace changed only once the guard had let the Space go.
    expect(server.pathsAtActivation).toEqual(['/spaces']);
  });

  it("opens the new Workspace's World, not the old one's, after leaving a Space", async () => {
    server.worlds = { default: 'world-default', lab: 'world-lab' };
    useWorkspaceStore.setState({ worldEnabled: true });
    await mount('/canvas/space-in-default');
    await open();
    await click(document.querySelector('input[type="radio"][value="lab"]'));
    await click(buttonNamed('workspace.switchTo {"workspace":"Research lab"}'));
    // Left for a page that names no Workspace, then landed in the new one.
    expect(server.pathsAtActivation).toEqual(['/spaces']);
    expect(path).toBe('/canvas/world-lab');
    expect(label()).toBe('Research lab');
  });

  it('keeps a long name from pushing Cancel out of the dialog', async () => {
    const long = 'L'.repeat(120);
    server.workspaces[1].name = long;
    await mount();
    await open();
    await click(document.querySelector('input[type="radio"][value="lab"]'));
    const cancel = buttonNamed('actions.cancel');
    const confirm = buttonNamed(`workspace.switchTo {"workspace":"${long}"}`);
    // jsdom has no layout, so check the classes that keep the footer in
    // bounds: Cancel never shrinks; the confirmation shrinks and truncates
    // while its text, and so its accessible name, stays whole.
    expect(cancel?.className).toContain('shrink-0');
    expect(confirm?.className).toContain('min-w-0');
    expect(confirm?.querySelector('span')?.className).toContain('truncate');
  });

  it('stays in the Space, unswitched, when a late save fails and the person stays', async () => {
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
    // The guard asks; nothing has been activated meanwhile.
    expect(dialog()?.textContent).toContain('app.unsavedChangesTitle');
    expect(server.calls).toEqual([]);
    expect(useWorkspaceSwitcherUiStore.getState().switching).toBe(true);

    await click(buttonNamed('app.stayInSpace'));
    expect(path).toBe('/canvas/space-in-default');
    expect(server.calls).toEqual([]);
    expect(label()).toBe('Default');
    expect(useWorkspaceSwitcherUiStore.getState().switching).toBe(false);
  });

  it('settles pending work with input frozen before switching from the Spaces page', async () => {
    const inertDuringSave: boolean[] = [];
    mocks.saved.mockImplementationOnce(async () => {
      inertDuringSave.push(document.body.inert);
      return true;
    });
    await mount();
    await click(trigger());
    await click(buttonNamed(/Research lab/));
    expect(inertDuringSave).toEqual([true]);
    expect(document.body.inert).toBe(false);
    expect(mocks.drain).not.toHaveBeenCalled();
    expect(server.calls).toEqual(['activate lab']);
  });

  it('makes one switch at a time while an open Space is still saving', async () => {
    let saved: () => void = () => {};
    mocks.saved.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (saved = () => resolve(true))),
    );
    await mount('/canvas/space-in-default');
    await open();
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[type="radio"][value="lab"]')!
        .click(),
    );
    await click(buttonNamed('workspace.switchTo {"workspace":"Research lab"}'));
    expect(useWorkspaceSwitcherUiStore.getState().switching).toBe(true);

    // The quick switch offers nothing to choose until the first switch ends.
    await click(trigger());
    const lab = buttonNamed(/Research lab/)!;
    expect(lab.disabled).toBe(true);
    await act(async () => lab.click());
    await key('Escape');

    await act(async () => saved());
    expect(mocks.saved).toHaveBeenCalledTimes(1);
    expect(server.calls).toEqual(['activate lab']);
    expect(useWorkspaceSwitcherUiStore.getState().switching).toBe(false);
  });

  it('stays put when the open Space cannot be saved', async () => {
    mocks.saved.mockResolvedValueOnce(false);
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

  it('keeps the dialog and the typed name when creating fails', async () => {
    server.failCreate = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.toast.mockReturnValueOnce('create-failed');
    await mount();
    await open();
    const name = [...document.querySelectorAll('label')].find(
      (label) => label.textContent === 'workspace.newWorkspace',
    );
    const input = () =>
      document.querySelector<HTMLInputElement>(`[id="${name?.htmlFor}"]`);
    const field = input();
    if (!field) throw new Error('No name field');
    await type(field, 'Side project');
    await click(buttonNamed('workspace.create'));
    expect(server.calls).toEqual(['create Side project']);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tone: 'danger' }),
    );
    expect(dialog()).not.toBeNull();
    expect(input()?.value).toBe('Side project');
    expect(useWorkspaceSwitcherUiStore.getState().switching).toBe(false);

    // Retrying from the kept name works, and takes the failure down.
    server.failCreate = false;
    await click(buttonNamed('workspace.create'));
    expect(server.calls).toEqual([
      'create Side project',
      'create Side project',
      'activate new-2',
    ]);
    expect(dialog()).toBeNull();
    expect(label()).toBe('Side project');
    expect(dismissToast).toHaveBeenCalledWith('create-failed');
  });

  it('finishes a create that landed even when the list then fails to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mount();
    await open();
    await type(nameField(), 'Side project');
    server.failList = true;
    await click(buttonNamed('workspace.create'));
    expect(server.calls).toEqual(['create Side project', 'activate new-2']);
    expect(dialog()).toBeNull();
    expect(label()).toBe('Side project');
    expect(useWorkspaceStore.getState().error).toBeNull();
    expect(mocks.toast.mock.calls[0][1]).toMatchObject({ tone: 'success' });
    expect(server.workspaces.map((w) => w.workspaceId)).toEqual([
      'default',
      'lab',
      'new-2',
    ]);

    // The kept list marks the new Workspace current, so the one left is a
    // row that switches back rather than a dead one.
    await click(trigger());
    const rows = [
      ...document.querySelectorAll('[role="dialog"] [role="listitem"]'),
    ];
    const current = rows.filter((row) =>
      row.querySelector('[aria-current="true"]'),
    );
    expect(current.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Side project'),
    ]);
    await click(buttonNamed(/Default/));
    expect(server.calls.at(-1)).toBe('activate default');
    expect(label()).toBe('Default');
  });

  it('gets the Workspace a create made when its answer was lost, on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server.loseCreateAnswer = true;
    await mount();
    await open();
    await type(nameField(), 'Work log');
    await click(buttonNamed('workspace.create'));
    expect(dialog()).not.toBeNull();
    expect(label()).toBe('Default');

    await click(buttonNamed('workspace.create'));
    expect(server.calls).toEqual([
      'create Work log',
      'create Work log',
      'activate new-2',
    ]);
    // Both attempts are one create to the Server.
    expect(server.createRequestIds[0]).toBeTruthy();
    expect(server.createRequestIds[1]).toBe(server.createRequestIds[0]);
    expect(server.workspaces.map((w) => w.workspaceId)).toEqual([
      'default',
      'lab',
      'new-2',
    ]);
    expect(dialog()).toBeNull();
    expect(label()).toBe('Work log');

    // A new create of the same name is a new request, not a replay.
    await open();
    await type(nameField(), 'Work log');
    await click(buttonNamed('workspace.create'));
    expect(server.createRequestIds[2]).not.toBe(server.createRequestIds[0]);
    expect(server.workspaces.map((w) => w.workspaceId)).toEqual([
      'default',
      'lab',
      'new-2',
      'new-3',
    ]);
  });

  it('activates the Workspace already made when retrying after activation failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.toast
      .mockReturnValueOnce('first-failure')
      .mockReturnValueOnce('second-failure');
    server.failActivate = 'before';
    await mount();
    await open();
    await type(nameField(), 'Side project');
    await click(buttonNamed('workspace.create'));
    expect(dialog()).not.toBeNull();
    expect(label()).toBe('Default');

    // A second failure replaces the first one's toast rather than stacking.
    await click(buttonNamed('workspace.create'));
    expect(vi.mocked(dismissToast).mock.calls).toEqual([['first-failure']]);

    server.failActivate = null;
    await click(buttonNamed('workspace.create'));
    expect(server.calls).toEqual([
      'create Side project',
      'activate new-2',
      'activate new-2',
      'activate new-2',
    ]);
    expect(server.workspaces.map((w) => w.workspaceId)).toEqual([
      'default',
      'lab',
      'new-2',
    ]);
    expect(dialog()).toBeNull();
    expect(label()).toBe('Side project');
    expect(dismissToast).toHaveBeenCalledWith('second-failure');
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
    const open = vi.fn(async (_target: unknown) => ({ ok: true }));
    mocks.bridge = { tabs: { context: { role: 'space' }, open } };
    await mount('/canvas/a');
    await click(buttonNamed('Menu: Switch Workspace'));
    // The Space tab stays; the navigation guard forwards the request to Home,
    // whose own Switch Workspace dialog acts on it.
    expect(open).toHaveBeenCalledWith({
      canvasId: null,
      homePath: '/spaces',
      state: { [OPEN_WORKSPACE_SWITCHER]: 'choose' },
    });
    expect(path).toBe('/canvas/a');
    expect(useWorkspaceSwitcherUiStore.getState().isOpen).toBe(false);
  });

  describe('desktop Home menu', () => {
    const command = vi.fn(async (_command: unknown) => ({ ok: true }));
    let showMenu: (position: { x: number } | null) => void = () => {};
    beforeEach(() => {
      mocks.bridge = {
        tabs: {
          context: { role: 'home' },
          onHomeMenu: (listener) => {
            showMenu = listener;
            return () => {};
          },
          command,
          beginWorkspaceChange: async () => ({ ok: true }),
          endWorkspaceChange: async () => ({ ok: true }),
          workspaceReady: async () => ({ ok: true }),
        },
      };
    });
    const menuItem = (text: RegExp) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => text.test(item.textContent ?? ''),
      );

    it('switches a named Recent Workspace like every other chooser', async () => {
      await mount();
      await act(async () => showMenu({ x: 76 }));
      await click(menuItem(/Research lab/));
      expect(mocks.saved).toHaveBeenCalledTimes(1);
      expect(server.calls).toEqual(['activate lab']);
      expect(label()).toBe('Research lab');
      expect(path).toBe('/spaces');
      const [message, options] = mocks.toast.mock.calls[0] as [
        string,
        { action?: { label: string } },
      ];
      expect(message).toBe(
        'workspace.switchedCount {"workspace":"Research lab","count":14}',
      );
      expect(options.action?.label).toBe(
        'workspace.backTo {"workspace":"Default"}',
      );
    });

    it('hands over to the dialog without sending focus back to the Shell', async () => {
      await mount();
      await act(async () => showMenu({ x: 76 }));
      await click(menuItem(/workspace\.allWorkspaces/));
      expect(useWorkspaceSwitcherUiStore.getState().isOpen).toBe(true);
      expect(command).toHaveBeenCalledWith('dismiss-home-menu');
      expect(command).not.toHaveBeenCalledWith('close-home-menu');
    });
  });

  it('opens the dialog on Home when a Space tab forwards the request', async () => {
    mocks.bridge = { tabs: { context: { role: 'home' } } };
    await mount({
      pathname: '/spaces',
      state: { [OPEN_WORKSPACE_SWITCHER]: 'choose' },
    });
    expect(useWorkspaceSwitcherUiStore.getState().isOpen).toBe(true);
    expect(path).toBe('/spaces');
  });
});
