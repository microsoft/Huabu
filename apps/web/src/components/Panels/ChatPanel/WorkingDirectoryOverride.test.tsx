// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { i18n } from '@/i18n';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { usePanelStore } from '@/store/panelStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { WorkingDirectoryOverride } from './WorkingDirectoryOverride';

import type * as WorkspaceApi from '@/api/workspace';

const picker = vi.hoisted(() => ({ pick: vi.fn() }));
vi.mock('@/components/Common/Loading', () => ({
  Loading: () => <span>Loading</span>,
}));
vi.mock('@/api/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceApi>()),
  pickFolder: picker.pick,
}));

let container: HTMLDivElement;
let root: Root;

async function render(
  props: React.ComponentProps<typeof WorkingDirectoryOverride>,
) {
  await act(async () => root.render(<WorkingDirectoryOverride {...props} />));
}

async function openPopover() {
  const trigger = container.querySelector<HTMLButtonElement>('button');
  assert(trigger);
  await act(async () => trigger.click());
}

function nodeOverrideInput(): HTMLTextAreaElement {
  const input = document.body.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Working directory"]',
  );
  assert(input);
  return input;
}

async function clickAction(label: string) {
  const button = [...document.body.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === label ||
      candidate.textContent === label,
  );
  assert(button);
  await act(async () => button.click());
}

async function changePath(value: string) {
  const input = nodeOverrideInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    assert(setter);
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  picker.pick.mockReset();
  useAcpProfilesStore.setState({
    connectedDevices: [],
    folderPickerAgentletId: null,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('WorkingDirectoryOverride', () => {
  const defaultProps = {
    profileWorkingDirPath: '/profiles/default',
    editable: true,
    saving: false,
  };
  it('browses the exact effective device/path without changing the execution directory', async () => {
    useCanvasStore.setState({ canvasId: 'canvas-files' });
    const onSave = vi.fn();
    await render({
      ...defaultProps,
      agentletId: 'frozen-device',
      effectiveWorkingDirPath: '/frozen/path',
      editable: false,
      onSave,
    });
    await openPopover();
    await clickAction('Browse files');
    expect(usePanelStore.getState()).toMatchObject({
      leftMode: 'files',
      isLeftCollapsed: false,
      filesLocation: {
        canvasId: 'canvas-files',
        agentletId: 'frozen-device',
        path: '/frozen/path',
      },
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('offers picking only while editing on the confirmed device and saves only on Done', async () => {
    useWorkspaceStore.setState({
      capabilities: { nativePicker: true, canChangeWorkspace: true },
    });
    useAcpProfilesStore.setState({
      folderPickerAgentletId: 'local',
      connectedDevices: [
        {
          agentletId: 'local',
          displayName: 'Local',
          version: '1',
          connectedAt: '',
          profileCount: 0,
        },
      ],
    });
    picker.pick.mockResolvedValue({ ok: true, path: '/selected' });
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({ ...defaultProps, agentletId: 'local', onSave });
    await openPopover();
    const field = nodeOverrideInput();
    expect(
      document.body.querySelector('[aria-label="Pick a folder"]'),
    ).toBeNull();
    await clickAction('Change');
    await clickAction('Pick a folder');
    expect(nodeOverrideInput()).toBe(field);
    expect(field.value).toBe('/selected');
    expect(onSave).not.toHaveBeenCalled();
    await clickAction('Done');
    expect(onSave).toHaveBeenCalledWith('/selected');
  });

  it('releases the pending picker after a device disconnect and keeps the draft', async () => {
    useWorkspaceStore.setState({
      capabilities: { nativePicker: true, canChangeWorkspace: true },
    });
    useAcpProfilesStore.setState({
      folderPickerAgentletId: 'local',
      connectedDevices: [
        {
          agentletId: 'local',
          displayName: 'Local',
          version: '1',
          connectedAt: '',
          profileCount: 0,
        },
      ],
    });
    let resolve!: (result: { ok: true; path: string }) => void;
    picker.pick.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const onSave = vi.fn();
    await render({ ...defaultProps, agentletId: 'local', onSave });
    await openPopover();
    await clickAction('Change');
    await changePath('/unsaved');
    await clickAction('Pick a folder');
    expect(
      [...document.body.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Done',
      )?.disabled,
    ).toBe(true);
    await act(async () =>
      useAcpProfilesStore.setState({ connectedDevices: [] }),
    );
    await act(async () => resolve({ ok: true, path: '/stale' }));
    expect(nodeOverrideInput().value).toBe('/unsaved');
    expect(
      document.body.querySelector('[role="alert"]')?.textContent,
    ).toContain('target device changed');
    expect(
      [...document.body.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === 'Done',
      )?.disabled,
    ).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps the folder tooltip to its label without duplicating path or device information', async () => {
    await render({
      ...defaultProps,
      deviceName: 'dev-server: linux x64',
      onSave: vi.fn(),
    });
    const trigger = container.querySelector<HTMLButtonElement>('button');
    assert(trigger);
    await act(async () => trigger.focus());
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Working directory',
      );
    });
    await openPopover();
    expect(nodeOverrideInput().value).toBe('/profiles/default');
    expect(document.body.textContent).toContain('dev-server: linux x64');
  });

  it('edits in the same one-row field and never saves on blur', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({ ...defaultProps, onSave });
    await openPopover();
    const input = nodeOverrideInput();
    expect(input.getAttribute('rows')).toBe('1');
    expect(input.className).toContain('min-h-[1lh]');
    expect(input.className).not.toContain('truncate');
    await clickAction('Change');
    expect(nodeOverrideInput()).toBe(input);
    expect(input.readOnly).toBe(false);
    await changePath('/another/project');
    await act(async () =>
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
    );
    expect(onSave).not.toHaveBeenCalled();
    await clickAction('Done');
    expect(onSave).toHaveBeenCalledWith('/another/project');
  });

  it('does not turn an unchanged inherited path into an explicit override', async () => {
    const onSave = vi.fn();
    await render({ ...defaultProps, onSave });
    await openPopover();
    await clickAction('Change');
    await clickAction('Done');
    expect(onSave).not.toHaveBeenCalled();
    expect(nodeOverrideInput().readOnly).toBe(true);
  });

  it('cancels changes with Cancel and Escape without dismissing the popover', async () => {
    const onSave = vi.fn();
    await render({ ...defaultProps, onSave });
    await openPopover();
    await clickAction('Change');
    await changePath('/discard');
    await clickAction('Cancel');
    expect(nodeOverrideInput().value).toBe('/profiles/default');
    await clickAction('Change');
    await changePath('/discard-again');
    await act(async () =>
      nodeOverrideInput().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(nodeOverrideInput().value).toBe('/profiles/default');
    expect(nodeOverrideInput().readOnly).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('discards an unsaved draft when closed and reopened', async () => {
    const onSave = vi.fn();
    await render({ ...defaultProps, onSave });
    await openPopover();
    await clickAction('Change');
    await changePath('/unsaved');
    await openPopover();
    expect(document.body.querySelector('textarea')).toBeNull();
    await openPopover();
    expect(nodeOverrideInput().value).toBe('/profiles/default');
    expect(nodeOverrideInput().readOnly).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'dismisses on a blank canvas press without saving (editing: %s)',
    async (editing) => {
      const onSave = vi.fn();
      await render({ ...defaultProps, onSave });
      await openPopover();
      if (editing) {
        await clickAction('Change');
        await changePath('/unsaved');
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      container.addEventListener(
        'pointerdown',
        (event) => event.stopImmediatePropagation(),
        { capture: true, once: true },
      );
      act(() =>
        container.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true }),
        ),
      );
      expect(document.body.querySelector('textarea')).toBeNull();
      expect(onSave).not.toHaveBeenCalled();
      await openPopover();
      expect(nodeOverrideInput().value).toBe('/profiles/default');
      expect(nodeOverrideInput().readOnly).toBe(true);
    },
  );

  it('commits on Enter but never during IME composition', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({ ...defaultProps, onSave });
    await openPopover();
    await clickAction('Change');
    await changePath('/new/path');
    await act(async () =>
      nodeOverrideInput().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onSave).not.toHaveBeenCalled();
    await act(async () =>
      nodeOverrideInput().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith('/new/path');
  });

  it('rejects multiline paths and retains the edit', async () => {
    const onSave = vi.fn();
    await render({ ...defaultProps, onSave });
    await openPopover();
    await clickAction('Change');
    await changePath('/first\n/second');
    await clickAction('Done');
    expect(onSave).not.toHaveBeenCalled();
    expect(nodeOverrideInput().value).toBe('/first\n/second');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Enter a single directory path.',
    );
  });

  it('retains the draft when restoring the default fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Save failed'));
    await render({ ...defaultProps, workingDirPath: '/override', onSave });
    await openPopover();
    await clickAction('Change');
    await changePath('/unsaved');
    await clickAction('Use default directory');
    expect(onSave).toHaveBeenCalledWith(null);
    expect(nodeOverrideInput().value).toBe('/unsaved');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Save failed',
    );
  });

  it('keeps pending edits stable and prevents duplicate saves or dismissal', async () => {
    let rejectSave: (error: Error) => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    await render({ ...defaultProps, onSave });
    await openPopover();
    await clickAction('Change');
    await changePath('/pending');
    await clickAction('Done');
    await render({ ...defaultProps, editable: false, saving: true, onSave });
    expect(document.body.querySelector('[aria-label="Done"]')).not.toBeNull();
    expect(nodeOverrideInput().value).toBe('/pending');
    expect(nodeOverrideInput().readOnly).toBe(true);
    await clickAction('Done');
    await openPopover();
    expect(onSave).toHaveBeenCalledOnce();
    expect(document.body.querySelector('textarea')).not.toBeNull();
    await render({ ...defaultProps, onSave });
    await act(async () => rejectSave(new Error('Retry save')));
    expect(nodeOverrideInput().value).toBe('/pending');
    expect(nodeOverrideInput().readOnly).toBe(false);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Retry save',
    );
  });

  it('uses the actual device name without repeating Profile metadata', async () => {
    await render({
      ...defaultProps,
      deviceName: 'dev-server: linux x64',
      onSave: vi.fn(),
    });
    await openPopover();
    expect(document.body.textContent).toContain('dev-server: linux x64');
    expect(document.body.textContent).not.toContain('Profile');
    expect(nodeOverrideInput().value).toBe('/profiles/default');
    expect(document.body.textContent).toContain('Runs on');
  });

  it('keeps Default and Cancel as visible text actions while editing', async () => {
    await render({ ...defaultProps, onSave: vi.fn() });
    await openPopover();
    await clickAction('Change');
    const buttons = [...document.body.querySelectorAll('button')];
    const restore = buttons.find(
      (button) => button.getAttribute('aria-label') === 'Use default directory',
    );
    const cancel = buttons.find(
      (button) => button.getAttribute('aria-label') === 'Cancel',
    );
    expect(restore?.textContent).toBe('Default');
    expect(cancel?.textContent).toBe('Cancel');
    expect(restore?.querySelector('svg')).toBeNull();
    expect(cancel?.querySelector('svg')).toBeNull();
  });

  it('shows unavailable device information rather than guessing local placement', async () => {
    await render({ ...defaultProps, onSave: vi.fn() });
    await openPopover();
    expect(document.body.textContent).toContain(
      'Device information unavailable',
    );
    expect(document.body.textContent).not.toContain('Local');
  });

  it('does not describe a temporarily unavailable draft as a fixed execution', async () => {
    await render({ ...defaultProps, editable: false, onSave: vi.fn() });
    await openPopover();
    expect(
      document.body.querySelector(
        '[aria-label="The working directory cannot be edited right now."]',
      ),
    ).not.toBeNull();
    expect(nodeOverrideInput().value).toBe('/profiles/default');
  });

  it('retains save failure feedback even if the execution becomes locked', async () => {
    let rejectSave: (error: Error) => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    await render({ ...defaultProps, onSave });
    await openPopover();
    await clickAction('Change');
    await changePath('/pending');
    await clickAction('Done');
    await render({ ...defaultProps, editable: false, onSave });
    await act(async () =>
      rejectSave(new Error('Execution needs reconciliation')),
    );
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Execution needs reconciliation',
    );
    expect(nodeOverrideInput().readOnly).toBe(true);
  });

  it('shows Profile inheritance and updates it without persisting a copy', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileWorkingDirPath: '/profiles/first',
      editable: true,
      saving: false,
      onSave,
    });
    expect(document.body.textContent).not.toContain(
      'Inheriting Profile directory',
    );
    await openPopover();

    const input = nodeOverrideInput();
    expect(input.value).toBe('/profiles/first');
    expect(input.readOnly).toBe(true);
    expect(document.body.textContent).not.toContain('Profile');

    await render({
      profileWorkingDirPath: '/profiles/second',
      editable: true,
      saving: false,
      onSave,
    });
    const updatedInput = nodeOverrideInput();
    expect(updatedInput?.value).toBe('/profiles/second');
    expect(updatedInput?.placeholder).toBe('/profiles/second');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('preserves an explicit override across Profile changes and clears to null', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileWorkingDirPath: '/profiles/first',
      workingDirPath: '/node/work',
      editable: true,
      saving: false,
      onSave,
    });
    await openPopover();
    await render({
      profileWorkingDirPath: '/profiles/second',
      workingDirPath: '/node/work',
      editable: true,
      saving: false,
      onSave,
    });
    const input = nodeOverrideInput();
    expect(input.value).toBe('/node/work');

    await clickAction('Change');
    await changePath('');
    await clickAction('Done');
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('keeps locked explicit and inherited directories available read-only', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileWorkingDirPath: '/profiles/default',
      workingDirPath: '/node/work',
      editable: false,
      saving: false,
      onSave,
    });
    expect(container.textContent).not.toContain('/node/work');
    await openPopover();
    expect(nodeOverrideInput().value).toBe('/node/work');
    expect(nodeOverrideInput().readOnly).toBe(true);
    expect(document.body.querySelector('input')).toBeNull();

    await render({
      profileWorkingDirPath: '/profiles/default',
      editable: false,
      saving: false,
      onSave,
    });
    expect(container.querySelector('button')).not.toBeNull();
    expect(nodeOverrideInput().value).toBe('/profiles/default');
    expect(nodeOverrideInput().readOnly).toBe(true);
    expect(document.body.querySelector('[aria-label="Change"]')).toBeNull();
    expect(document.body.querySelector('input')).toBeNull();
  });

  it('surfaces server validation errors without replacing the draft', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Must be absolute'));
    await render({
      profileWorkingDirPath: '/profiles/default',
      editable: true,
      saving: false,
      onSave,
    });
    await openPopover();
    await clickAction('Change');
    const input = nodeOverrideInput();
    await changePath('relative/path');
    await clickAction('Done');
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Must be absolute',
    );
    expect(input.value).toBe('relative/path');
  });

  it('marks an explicit override and restores inheritance explicitly', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    await render({
      profileWorkingDirPath: '/profiles/default',
      workingDirPath: '/node/work',
      editable: true,
      saving: false,
      onSave,
    });
    expect(
      container.querySelector('[aria-label="Working directory: /node/work"]'),
    ).not.toBeNull();
    await openPopover();
    await clickAction('Change');
    await clickAction('Use default directory');
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('shows a frozen inherited path without an override marker after the Profile changes', async () => {
    await render({
      profileWorkingDirPath: '/profiles/new',
      effectiveWorkingDirPath: '/profiles/original',
      directorySource: 'profile',
      editable: false,
      saving: false,
      onSave: vi.fn(),
    });
    const trigger = container.querySelector('button');
    expect(trigger?.getAttribute('aria-label')).toBe(
      'Working directory: /profiles/original',
    );
    expect(trigger?.querySelector('span')).toBeNull();
    await openPopover();
    expect(nodeOverrideInput().value).toBe('/profiles/original');
    expect(nodeOverrideInput().readOnly).toBe(true);
    expect(document.body.textContent).not.toContain('/profiles/new');
    expect(document.body.querySelector('input')).toBeNull();
  });

  it('marks an explicit override even when it equals the Profile default', async () => {
    await render({
      profileWorkingDirPath: '/same',
      workingDirPath: '/same',
      effectiveWorkingDirPath: '/same',
      directorySource: 'override',
      editable: false,
      saving: false,
      onSave: vi.fn(),
    });
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Working directory: /same',
    );
    expect(container.querySelector('button .bg-info')).not.toBeNull();
  });

  it('does not infer directory origin for a legacy execution or fall back to a changed Profile', async () => {
    const props = {
      profileWorkingDirPath: '/profiles/new',
      effectiveWorkingDirPath: '/legacy',
      directorySource: 'unknown' as const,
      editable: false,
      saving: false,
      onSave: vi.fn(),
    };
    await render(props);
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Working directory: /legacy',
    );
    expect(container.querySelector('button .bg-info')).toBeNull();
    await render({ ...props, effectiveWorkingDirPath: null });
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Working directory: Not specified',
    );
    await openPopover();
    expect(nodeOverrideInput().value).toBe('Not specified');
  });
});
