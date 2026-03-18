import type {
  CanvasAlignDirection,
  CanvasCommand,
  CanvasDistributionAxis,
  CanvasExecution,
  CanvasNodeType,
  Point,
} from '@sediment/shared';

export interface CanvasFlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasUiSelectionMode = 'replace' | 'toggle';

/**
 * Web-only user interaction intents that must be resolved before execution.
 */
export type CanvasUiIntent =
  | {
      type: 'ADD_NODE_FROM_TOOLBAR';
      nodeType: CanvasNodeType;
      flowPosition?: Point;
    }
  | { type: 'GROUP_SELECTION_INTO_FRAME'; frameLabel?: string }
  | {
      type: 'GROUP_RECT_INTO_FRAME';
      flowRect: CanvasFlowRect;
      frameLabel?: string;
    }
  | { type: 'PASTE_CLIPBOARD'; flowPosition?: Point }
  | { type: 'NODE_DRAG_STOP'; draggedNodeIds: string[] }
  | {
      type: 'SELECT_NODES';
      nodeIds: string[];
      mode?: CanvasUiSelectionMode;
    }
  | {
      type: 'ALIGN_SELECTED_NODES';
      direction: CanvasAlignDirection;
    }
  | {
      type: 'DISTRIBUTE_SELECTED_NODES';
      axis: CanvasDistributionAxis;
    }
  | { type: 'AUTO_LAYOUT_SELECTION' };

export type CanvasUiIntentType = CanvasUiIntent['type'];

/**
 * Output contract for future resolvers that translate web-only intent into execution batches.
 */
export interface CanvasUiIntentResolution {
  intent: CanvasUiIntent;
  execution: CanvasExecution;
  commands: CanvasCommand[];
}
