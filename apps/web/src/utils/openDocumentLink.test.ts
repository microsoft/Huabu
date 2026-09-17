// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isElectron } from '@/hooks/useElectron';
import { settleNodePreprocess } from '@/store/canvasStore';
import { usePanelStore } from '@/store/panelStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { openDocumentLink } from './openDocumentLink';

vi.mock('@/hooks/useElectron', () => ({ isElectron: vi.fn() }));
vi.mock('@/store/canvasStore', () => ({
  default: { getState: vi.fn() },
  settleNodePreprocess: vi.fn(),
}));
vi.mock('@/store/chatStore', () => ({ useChatStore: { getState: vi.fn() } }));
vi.mock('@/store/panelStore', () => {
  const state = { requestOpenRightPanel: vi.fn() };
  return { usePanelStore: { getState: () => state } };
});

const canvasId = 'document-links-canvas';
const store = () => usePreviewWorkspaceStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'open').mockReturnValue(null);
  usePreviewWorkspaceStore.setState({
    canvasId,
    workspace: createEmptyWorkspace('group'),
  });
});

afterEach(() => vi.restoreAllMocks());

describe.each([true, false])('document links in Electron=%s', (inElectron) => {
  beforeEach(() => vi.mocked(isElectron).mockReturnValue(inElectron));

  it.each(['node', 'chat'] as const)(
    'routes links from a %s source',
    (kind) => {
      const tabId = store().openPreviewTarget(
        kind === 'node'
          ? { kind, canvasId, nodeId: 'note' }
          : { kind, canvasId, threadId: 'thread' },
        { transient: true },
      );
      const before = store().workspace;
      const source =
        kind === 'node' ? { nodeId: 'note' } : { threadId: 'thread' };

      openDocumentLink('  https://EXAMPLE.com:443/path?q=1#section  ', source);

      if (inElectron) {
        expect(window.open).not.toHaveBeenCalled();
        expect(store().workspace.tabs[tabId].transient).toBe(false);
        expect(
          Object.values(store().workspace.tabs).map((tab) => tab.target),
        ).toContainEqual({
          kind: 'url',
          canvasId,
          url: 'https://example.com/path?q=1#section',
        });
        expect(
          usePanelStore.getState().requestOpenRightPanel,
        ).toHaveBeenCalledOnce();
        if (kind === 'node') {
          expect(settleNodePreprocess).toHaveBeenCalledExactlyOnceWith('note');
        } else {
          expect(settleNodePreprocess).not.toHaveBeenCalled();
        }
      } else {
        expect(window.open).toHaveBeenCalledExactlyOnceWith(
          'https://EXAMPLE.com:443/path?q=1#section',
          '_blank',
          'noopener,noreferrer',
        );
        expect(store().workspace).toBe(before);
        expect(settleNodePreprocess).not.toHaveBeenCalled();
        expect(
          usePanelStore.getState().requestOpenRightPanel,
        ).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    '',
    '   ',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/page.html',
    'mailto:person@example.com',
    '/relative',
    '//example.com',
    'https://',
  ])(
    'rejects unsafe href %j without navigation or source promotion',
    (href) => {
      store().openPreviewTarget(
        { kind: 'chat', canvasId, threadId: 'thread' },
        { transient: true },
      );
      const before = store().workspace;

      openDocumentLink(href, { threadId: 'thread' });

      expect(store().workspace).toBe(before);
      expect(window.open).not.toHaveBeenCalled();
      expect(settleNodePreprocess).not.toHaveBeenCalled();
      expect(
        usePanelStore.getState().requestOpenRightPanel,
      ).not.toHaveBeenCalled();
    },
  );

  it('supports links without a source', () => {
    openDocumentLink('http://example.com');

    if (inElectron) {
      expect(
        Object.values(store().workspace.tabs).map((tab) => tab.target),
      ).toEqual([{ kind: 'url', canvasId, url: 'http://example.com/' }]);
      expect(window.open).not.toHaveBeenCalled();
    } else {
      expect(window.open).toHaveBeenCalledExactlyOnceWith(
        'http://example.com',
        '_blank',
        'noopener,noreferrer',
      );
      expect(Object.keys(store().workspace.tabs)).toHaveLength(0);
    }
    expect(settleNodePreprocess).not.toHaveBeenCalled();
  });
});
