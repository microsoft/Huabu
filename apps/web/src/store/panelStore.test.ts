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
