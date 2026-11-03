// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { REQUEST_DELETE_SPACE } from '@/utils/spaceHierarchy';

import { SpaceActions } from './SpaceActions';

const mocks = vi.hoisted(() => ({
  canvas: { canvasId: 'parent' },
  workspace: {
    workspaceId: 'workspace',
    spaceSummaries: { child: { parentSpaceId: 'parent' } },
  },
  navigate: vi.fn(),
  toast: vi.fn(),
  move: vi.fn(),
  translate: (key: string) => key,
  dialog: vi.fn<
    (props: {
      onDeleted: (ids: string[], failure?: string, completed?: boolean) => void;
    }) => null
  >(() => null),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/components/Common/Toast', () => ({ toast: mocks.toast }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate }),
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

function complete(ids: string[], failure?: string, completed?: boolean) {
  const props = mocks.dialog.mock.lastCall?.[0];
  if (!props) throw new Error('Missing deletion dialog');
  act(() => props.onDeleted(ids, failure, completed));
}

it('stays in the parent after deleting its child', () => {
  complete(['child']);
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it('leaves partial deletion errors in the parent dialog', () => {
  complete(['child'], 'Partial deletion');
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it.each(['parent', 'unrelated'])(
  'refuses deletion outside the child entry: %s',
  (id) => {
    mocks.dialog.mockClear();
    act(() =>
      window.dispatchEvent(
        new CustomEvent(REQUEST_DELETE_SPACE, { detail: id }),
      ),
    );
    expect(mocks.dialog).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      'spaceHierarchy.deleteFromContainer',
      { tone: 'warning' },
    );
  },
);

it('reports refresh failure after successfully deleting a child', () => {
  complete(['child'], 'Deleted, refresh failed', true);
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
    'Deleted, refresh failed',
    { tone: 'danger' },
  );
  expect(mocks.navigate).not.toHaveBeenCalled();
});
