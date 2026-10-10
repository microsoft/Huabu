// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import { usePanelStore } from './panelStore';

describe('panel store opening', () => {
  beforeEach(() => {
    usePanelStore.setState({
      isRightCollapsed: true,
    });
  });

  it('opens the panel on an explicit request', () => {
    usePanelStore.getState().requestOpenRightPanel();

    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: false,
    });
  });

  it('collapses an opened panel on toggle', () => {
    usePanelStore.getState().requestOpenRightPanel();
    usePanelStore.getState().toggleRightPanel();

    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: true,
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

describe('panel store canvas search focus', () => {
  beforeEach(() => {
    usePanelStore.setState({
      isLeftCollapsed: true,
      focusCanvasSearchRequest: null,
    });
  });

  it('expands the Layers panel on an explicit search focus request', () => {
    usePanelStore.getState().requestFocusCanvasSearch();

    expect(usePanelStore.getState()).toMatchObject({
      isLeftCollapsed: false,
      focusCanvasSearchRequest: 1,
    });
  });

  it('allows manual collapse without replaying the focus request', () => {
    usePanelStore.getState().requestFocusCanvasSearch();
    usePanelStore.getState().setLeftCollapsed(true);

    expect(usePanelStore.getState()).toMatchObject({
      isLeftCollapsed: true,
      focusCanvasSearchRequest: 1,
    });
  });

  it('advances the nonce for repeated focus requests', () => {
    usePanelStore.getState().requestFocusCanvasSearch();
    const first = usePanelStore.getState().focusCanvasSearchRequest;
    usePanelStore.getState().requestFocusCanvasSearch();

    expect(usePanelStore.getState().focusCanvasSearchRequest).toBeGreaterThan(
      first ?? 0,
    );
  });

  it('does not request search focus on manual panel expansion', () => {
    usePanelStore.getState().setLeftCollapsed(false);

    expect(usePanelStore.getState().focusCanvasSearchRequest).toBeNull();
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
