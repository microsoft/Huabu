// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { REQUEST_DELETE_SPACE } from '@/utils/spaceHierarchy';

import { SpaceActions } from './SpaceActions';

const mocks = vi.hoisted(() => ({
  canvas: { canvasId: 'child' },
  workspace: { workspaceId: 'workspace' },
  desktop: false,
  navigate: vi.fn(),
  toast: vi.fn(),
  move: vi.fn(),
  translate: (key: string) => key,
  dialog: vi.fn<
    (props: {
      onDeleted: (
        ids: string[],
        failure?: string,
        returnTo?: Record<string, string | null>,
        completed?: boolean,
      ) => void;
    }) => null
  >(() => null),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/components/Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));
vi.mock('@/hooks/useElectron', () => ({
  getElectronBridge: () => (mocks.desktop ? { tabs: {} } : undefined),
}));
vi.mock('@/store/canvasStore', () => ({
  default: Object.assign(
    (select: (state: typeof mocks.canvas) => unknown) => select(mocks.canvas),
    { getState: () => mocks.canvas },
  ),
}));
vi.mock('@/store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (select: (state: typeof mocks.workspace) => unknown) =>
      select(mocks.workspace),
    { getState: () => mocks.workspace },
  ),
}));
vi.mock('./moveNodesToSpace', () => ({
  moveNodesToSpace: mocks.move,
}));
vi.mock('./placeChildSpace', () => ({ placeChildSpace: vi.fn() }));
vi.mock('./SpaceOrganizationPopover', () => ({
  SpaceOrganizationPopover: () => null,
}));
vi.mock('./SpaceDeletionDialog', () => ({ SpaceDeletionDialog: mocks.dialog }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<SpaceActions />));
  act(() =>
    window.dispatchEvent(
      new CustomEvent(REQUEST_DELETE_SPACE, { detail: 'child' }),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function complete(
  ids: string[],
  returnTo: Record<string, string | null>,
  failure?: string,
  completed?: boolean,
) {
  const props = mocks.dialog.mock.lastCall?.[0];
  if (!props) throw new Error('Missing deletion dialog');
  act(() => props.onDeleted(ids, failure, returnTo, completed));
}

it('replaces a deleted browser page with its surviving parent', () => {
  complete(['child'], { child: 'parent' });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/canvas/parent', {
    replace: true,
  });
});

it('returns a deleted top-level browser page to Home', () => {
  complete(['child'], { child: null });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/spaces', {
    replace: true,
  });
});

it('does not navigate when another Space is deleted', () => {
  complete(['other'], { other: 'parent' });
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('leaves desktop navigation to the Tab manager', () => {
  mocks.desktop = true;
  complete(['child'], { child: 'parent' });
  expect(mocks.navigate).not.toHaveBeenCalled();
});

it('shows one toast only when a browser deletion error leaves the current page', () => {
  complete(['child'], { child: 'parent' }, 'Partial deletion');
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/canvas/parent', {
    replace: true,
  });
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('Partial deletion', {
    tone: 'danger',
  });
});

it('leaves errors in the dialog while the current Space survives', () => {
  complete(['other'], { other: 'parent' }, 'Partial deletion');
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it('does not duplicate the desktop destination notification', () => {
  mocks.desktop = true;
  complete(['child'], { child: 'parent' }, 'Partial deletion');
  expect(mocks.toast).not.toHaveBeenCalled();
});

it.each([false, true])(
  'reports refresh failure after successful deletion of another Space (desktop=%s)',
  (desktop) => {
    mocks.desktop = desktop;
    complete(['other'], { other: 'parent' }, 'Deleted, refresh failed', true);
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
      'Deleted, refresh failed',
      { tone: 'danger' },
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
  },
);
