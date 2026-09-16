// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  createEmptyWorkspace,
  openTarget,
} from '@/store/previewWorkspace/model';

import {
  canRetainPreviewNode,
  selectRetainedPreviewTabs,
} from './retainedPreviewTabs';

import type { Node } from '@xyflow/react';

function node(id: string, type: string): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} };
}

describe('selectRetainedPreviewTabs', () => {
  it('keeps the active tab and the most recent eligible inactive tab', () => {
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
    workspace = openTarget(
      workspace,
      { kind: 'node', canvasId: 'canvas', nodeId: 'c' },
      {},
      { tabId: 'c' },
    ).workspace;

    expect(
      selectRetainedPreviewTabs(
        workspace.groups[0],
        workspace,
        new Set(['a', 'b', 'c']),
      ).map((tab) => tab.id),
    ).toEqual(['b', 'c']);
  });

  it('does not retain inactive iframe or media previews', () => {
    let workspace = createEmptyWorkspace('g1');
    workspace = openTarget(
      workspace,
      { kind: 'node', canvasId: 'canvas', nodeId: 'web' },
      {},
      { tabId: 'web' },
    ).workspace;
    workspace = openTarget(
      workspace,
      { kind: 'node', canvasId: 'canvas', nodeId: 'note' },
      {},
      { tabId: 'note' },
    ).workspace;

    expect(
      selectRetainedPreviewTabs(
        workspace.groups[0],
        workspace,
        new Set(['note']),
      ).map((tab) => tab.id),
    ).toEqual(['note']);
  });

  it('retains ordinary Questions but not view-only Space previews', () => {
    expect(canRetainPreviewNode(node('question', 'question'))).toBe(true);
    expect(canRetainPreviewNode(node('preview', 'spacePreview'))).toBe(false);
  });
});
