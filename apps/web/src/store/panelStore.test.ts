// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import { usePanelStore } from './panelStore';

describe('panel store viewport anchor', () => {
  beforeEach(() => {
    usePanelStore.setState({
      isRightCollapsed: true,
      rightPanelAnchorNodeId: null,
    });
  });

  it('records the node associated with an explicit Chat open', () => {
    usePanelStore.getState().requestOpenRightPanel('node-1');

    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: false,
      rightPanelAnchorNodeId: 'node-1',
    });
  });

  it('does not retain an anchor for an ordinary panel toggle', () => {
    usePanelStore.getState().requestOpenRightPanel('node-1');
    usePanelStore.getState().toggleRightPanel();

    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: true,
      rightPanelAnchorNodeId: null,
    });
  });
});

describe('panel store preview fullscreen', () => {
  beforeEach(() => {
    usePanelStore.setState({
      isRightCollapsed: true,
      isPreviewFullscreen: false,
    });
  });

  it('opens Preview when entering fullscreen', () => {
    usePanelStore.getState().setPreviewFullscreen(true);

    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: false,
      isPreviewFullscreen: true,
    });
  });

  it('exits fullscreen when Preview collapses', () => {
    usePanelStore.getState().setPreviewFullscreen(true);
    usePanelStore.getState().toggleRightPanel();

    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: true,
      isPreviewFullscreen: false,
    });
  });
});

describe('panel store canvas search visibility', () => {
  beforeEach(() => {
    usePanelStore.setState({
      isLeftCollapsed: true,
      isSearchOpen: false,
    });
  });

  it('expands the Layers panel when canvas search opens', () => {
    usePanelStore.getState().setSearchOpen(true);

    expect(usePanelStore.getState()).toMatchObject({
      isLeftCollapsed: false,
      isSearchOpen: true,
    });
  });

  it('allows the Layers panel to stay collapsed while search remains open', () => {
    usePanelStore.getState().setSearchOpen(true);
    usePanelStore.getState().setLeftCollapsed(true);

    expect(usePanelStore.getState()).toMatchObject({
      isLeftCollapsed: true,
      isSearchOpen: true,
    });
  });
});

describe('panel store focus requests', () => {
  beforeEach(() => {
    usePanelStore.setState({ focusChatInputRequest: null });
  });

  it('names the thread whose composer should take focus', () => {
    usePanelStore.getState().requestFocusChatInput('thread-a');

    expect(usePanelStore.getState().focusChatInputRequest).toMatchObject({
      threadId: 'thread-a',
    });
  });

  it('advances the nonce so a repeat request re-fires focus', () => {
    usePanelStore.getState().requestFocusChatInput('thread-a');
    const first = usePanelStore.getState().focusChatInputRequest;

    usePanelStore.getState().requestFocusChatInput('thread-a');
    const second = usePanelStore.getState().focusChatInputRequest;

    expect(second?.nonce).toBeGreaterThan(first?.nonce ?? 0);
  });

  it('retargets rather than queueing when another thread asks', () => {
    usePanelStore.getState().requestFocusChatInput('thread-a');
    usePanelStore.getState().requestFocusChatInput('thread-b');

    // Only the latest request stands, so a composer that never got focus
    // cannot claim it later out of turn.
    expect(usePanelStore.getState().focusChatInputRequest).toMatchObject({
      threadId: 'thread-b',
    });
  });
});
