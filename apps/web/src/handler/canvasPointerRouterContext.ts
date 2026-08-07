// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { EffectiveInputMode } from '@/store/toolStore';
import type { ReactFlowInstance } from '@xyflow/react';

/**
 * Live context supplied to every canvas pointer recognizer on each event.
 *
 * Read fresh from refs by the router at dispatch time so a recognizer
 * always sees the current React Flow instance, device modes, and callbacks
 * even if the owning gesture started several renders ago.
 */
export interface CanvasPointerRouterContext {
  wrapper: HTMLDivElement;
  instance: ReactFlowInstance;
  inputMode: EffectiveInputMode;
  interactivityLocked: boolean;
  explicitToolActive: boolean;
  onTouchTakeover: () => void;
  onEmptyCanvasTap: () => void;
  /**
   * Select the node a non-mouse tap landed on. Used in Pen mode, where a
   * finger tap on a node is claimed by viewport navigation (the pen owns
   * ink/manipulation) but should still pick the node rather than clear.
   */
  onNodeTap: (nodeId: string) => void;
}
