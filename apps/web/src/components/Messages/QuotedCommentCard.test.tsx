// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { QuotedCommentCard } from './QuotedCommentCard';

import type { QuotedComment } from '@huabu/shared';

const sources: NonNullable<QuotedComment['source']>[] = [
  {
    kind: 'note',
    canvasId: 'remote',
    nodeId: 'node-source',
    snapshotRevision: 'rev',
  },
  { kind: 'pdf', canvasId: 'remote', nodeId: 'node-source', pages: [1] },
  {
    kind: 'file-reference',
    canvasId: 'remote',
    nodeId: 'node-source',
    agentletId: 'device',
    path: '/file.txt',
    contentVersion: 'a'.repeat(64),
    offsetUnit: 'utf-16',
    from: 0,
    to: 1,
    loadedLength: 1,
    complete: true,
  },
];

it.each(
  sources.flatMap((source) => [source, { ...source, canvasId: 'local' }]),
)('opens a $canvasId $kind source in its owning Space', async (source) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await i18n.changeLanguage('en');
  useCanvasStore.setState({ canvasId: 'local', nodes: [] });
  usePreviewWorkspaceStore.setState({
    canvasId: 'local',
    workspace: createEmptyWorkspace('group'),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <QuotedCommentCard
            comment={{
              quote: 'text',
              contextBefore: '',
              contextAfter: '',
              comment: 'explain',
              source,
            }}
          />
        ),
      },
    ],
    { initialEntries: ['/canvas/local'] },
  );
  try {
    await act(async () => root.render(<RouterProvider router={router} />));
    const button = host.querySelector<HTMLButtonElement>(
      '[data-quoted-comment] button',
    );
    if (!button) throw new Error('Missing source control');
    await act(async () => button.click());
    if (source.canvasId === 'local') {
      expect(router.state.location.pathname).toBe('/canvas/local');
      expect(router.state.location.search).toBe('');
      expect(
        Object.values(usePreviewWorkspaceStore.getState().workspace.tabs).map(
          (tab) => tab.target,
        ),
      ).toEqual([{ kind: 'node', canvasId: 'local', nodeId: 'node-source' }]);
    } else {
      expect(router.state.location.pathname).toBe('/canvas/remote');
      expect(router.state.location.search).toBe('?node=node-source');
      expect(router.state.location.state).toMatchObject({
        returnToSpace: 'local',
      });
      expect(
        Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
      ).toHaveLength(0);
    }
  } finally {
    act(() => root.unmount());
    router.dispose();
    host.remove();
    vi.unstubAllGlobals();
  }
});
