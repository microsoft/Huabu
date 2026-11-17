// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasPresenceStore } from './canvasPresenceStore';
import { pageIsEditing } from './localEditing';

function mount(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  useCanvasPresenceStore.getState().setLocalEditingNodeId(null);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('pageIsEditing', () => {
  it('is true while the editing tracker reports a node', () => {
    expect(pageIsEditing()).toBe(false);
    useCanvasPresenceStore.getState().setLocalEditingNodeId('node-a');
    expect(pageIsEditing()).toBe(true);
  });

  it('is true for a focused text control of the canvas that belongs to no node', () => {
    mount('<div data-canvas-root><input id="edge-label" /></div>');
    document.getElementById('edge-label')?.focus();
    expect(pageIsEditing()).toBe(true);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    expect(pageIsEditing()).toBe(false);
  });

  it('leaves a node control to the tracker, which gives an idle one up', () => {
    mount(
      '<div data-canvas-root><div class="react-flow__node" data-id="node-a"><textarea id="body"></textarea></div></div><div data-search-node-id="node-a"><input id="property" /></div>',
    );
    document.getElementById('body')?.focus();
    expect(pageIsEditing()).toBe(false);
    document.getElementById('property')?.focus();
    expect(pageIsEditing()).toBe(false);
  });

  it('ignores read-only fields and controls outside the canvas', () => {
    mount(
      '<div data-canvas-root><input id="mirror" readonly /></div><textarea id="composer"></textarea>',
    );
    document.getElementById('mirror')?.focus();
    expect(pageIsEditing()).toBe(false);
    document.getElementById('composer')?.focus();
    expect(pageIsEditing()).toBe(false);
  });
});
