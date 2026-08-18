// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import {
  activateTab,
  createEmptyWorkspace,
  openTarget,
} from '@/store/previewWorkspace/model';

import { PreviewGroup } from './PreviewGroup';

import type { CanvasPreviewWorkspace } from '@/store/previewWorkspace/model';
import type { Node } from '@xyflow/react';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const trackers = vi.hoisted(() => ({
  effectEvents: [] as string[],
  rendererProps: new Map<
    string,
    {
      chatOpenRequest?: { nonce: number };
      hasFocusPriority: boolean;
      nodeFocusRequestNonce?: number;
    }
  >(),
  tabStripRenders: 0,
}));

vi.mock('./PreviewTabStrip', () => ({
  panelElementId: (groupId: string) => `panel-${groupId}`,
  tabElementId: (groupId: string, tabId: string) => `tab-${groupId}-${tabId}`,
  PreviewTabStrip: () => {
    trackers.tabStripRenders += 1;
    return <div data-testid="tab-strip" />;
  },
}));

vi.mock('./PreviewRenderer', () => ({
  PreviewRenderer: ({
    tabId,
    chatOpenRequest,
    hasFocusPriority,
    nodeFocusRequestNonce,
  }: {
    tabId: string;
    chatOpenRequest?: { nonce: number };
    hasFocusPriority: boolean;
    nodeFocusRequestNonce?: number;
  }) => {
    const [count, setCount] = useState(0);
    trackers.rendererProps.set(tabId, {
      chatOpenRequest,
      hasFocusPriority,
      nodeFocusRequestNonce,
    });
    useEffect(() => {
      trackers.effectEvents.push(`setup:${tabId}`);
      return () => {
        trackers.effectEvents.push(`cleanup:${tabId}`);
      };
    }, [tabId]);
    return (
      <button
        type="button"
        data-testid={`renderer-${tabId}`}
        data-count={count}
        onClick={() => setCount((current) => current + 1)}
      />
    );
  },
}));

function node(id: string, x = 0): Node {
  return {
    id,
    type: 'note',
    position: { x, y: 0 },
    data: { label: id },
  };
}

function workspaceWithTwoTabs(): CanvasPreviewWorkspace {
  let workspace = createEmptyWorkspace('g1');
  workspace = openTarget(
    workspace,
    { kind: 'node', canvasId: 'canvas', nodeId: 'a' },
    {},
    { tabId: 'a' },
  ).workspace;
  workspace = openTarget(
    workspace,
    { kind: 'node', canvasId: 'canvas', nodeId: 'b' },
    {},
    { tabId: 'b' },
  ).workspace;
  return workspace;
}

let container: HTMLDivElement;
let root: Root;

function renderGroup(
  workspace: CanvasPreviewWorkspace,
  requests: {
    chatOpenRequest?: {
      tabId: string;
      position: 'last-user' | 'bottom';
      nonce: number;
    };
    nodeFocusRequest?: { tabId: string; nonce: number };
  } = {},
) {
  root.render(
    <PreviewGroup
      group={workspace.groups[0]}
      workspace={workspace}
      isFocused
      onFocus={vi.fn()}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onPromote={vi.fn()}
      nodeFocusRequest={requests.nodeFocusRequest ?? null}
      onNodeFocusRequestHandled={vi.fn()}
      chatOpenRequest={requests.chatOpenRequest ?? null}
      onChatOpenRequestHandled={vi.fn()}
      onOpenToSide={vi.fn()}
      onNewChat={vi.fn()}
      tabDropIndicator={null}
      isFullscreen={false}
    />,
  );
}

beforeEach(() => {
  trackers.effectEvents.length = 0;
  trackers.rendererProps.clear();
  trackers.tabStripRenders = 0;
  useCanvasStore.setState({
    canvasId: 'canvas',
    nodes: [node('a'), node('b')],
    worldReferences: {},
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useCanvasStore.setState({ canvasId: '', nodes: [], worldReferences: {} });
});

describe('PreviewGroup retention', () => {
  it('does not rerender the group when only node positions change', async () => {
    const workspace = workspaceWithTwoTabs();
    await act(async () => renderGroup(workspace));
    const rendersBeforeMove = trackers.tabStripRenders;

    await act(async () => {
      useCanvasStore.setState({ nodes: [node('a', 100), node('b')] });
    });

    expect(trackers.tabStripRenders).toBe(rendersBeforeMove);
  });

  it('retains state while hidden and restarts effects when shown', async () => {
    let workspace = workspaceWithTwoTabs();
    await act(async () => renderGroup(workspace));

    const activeRenderer = container.querySelector<HTMLButtonElement>(
      '[data-testid="renderer-b"]',
    );
    expect(activeRenderer).not.toBeNull();
    act(() => activeRenderer?.click());
    expect(activeRenderer?.dataset.count).toBe('1');

    workspace = activateTab(workspace, 'a');
    await act(async () => renderGroup(workspace));
    expect(trackers.effectEvents).toContain('cleanup:b');

    workspace = activateTab(workspace, 'b');
    await act(async () => renderGroup(workspace));
    expect(
      container.querySelector<HTMLElement>('[data-testid="renderer-b"]')
        ?.dataset.count,
    ).toBe('1');
    expect(
      trackers.effectEvents.filter((event) => event === 'setup:b'),
    ).toHaveLength(2);
  });

  it('does not deliver focus or opening requests to a hidden renderer', async () => {
    const workspace = workspaceWithTwoTabs();
    await act(async () =>
      renderGroup(workspace, {
        nodeFocusRequest: { tabId: 'a', nonce: 1 },
        chatOpenRequest: { tabId: 'a', position: 'bottom', nonce: 2 },
      }),
    );

    expect(trackers.rendererProps.get('a')).toEqual({
      chatOpenRequest: undefined,
      hasFocusPriority: false,
      nodeFocusRequestNonce: undefined,
    });
    expect(trackers.rendererProps.get('b')?.hasFocusPriority).toBe(true);
  });
});
