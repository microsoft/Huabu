import type {
  EffectiveDeviceMode,
  EffectiveTouchInteractionMode,
} from '@/store/toolStore';

export type CanvasTool = 'select' | 'pan' | 'lasso';

// React Flow DOM class selectors used for pointer-target ownership checks.
// Centralised here so every gesture path agrees on what a panel, node, or
// empty pane target is, instead of duplicating `closest()` string matches.
const REACT_FLOW_PANE = '.react-flow__pane';
const REACT_FLOW_PANEL = '.react-flow__panel';
const REACT_FLOW_NODE = '.react-flow__node';
const REACT_FLOW_INTERACTIVE =
  '.react-flow__panel, .react-flow__node, .react-flow__edge, .react-flow__handle';

/** True when the pointer target lives inside a floating panel or toolbar. */
export function isPanelTarget(target: Element | null): boolean {
  return Boolean(target?.closest(REACT_FLOW_PANEL));
}

/** Closest canvas node element for the pointer target, or `null`. */
export function closestNodeElement(target: Element | null): HTMLElement | null {
  return target?.closest<HTMLElement>(REACT_FLOW_NODE) ?? null;
}

/** True when the pointer target lives inside a canvas node. */
export function isNodeTarget(target: Element | null): boolean {
  return closestNodeElement(target) !== null;
}

/**
 * True when the pointer target is empty canvas: inside the React Flow pane
 * but not over a panel, node, edge, or handle. Shared by click-to-place
 * creation and lasso start so both agree on what "empty canvas" means.
 */
export function isEmptyPaneTarget(target: Element | null): boolean {
  return Boolean(
    target?.closest(REACT_FLOW_PANE) && !target.closest(REACT_FLOW_INTERACTIVE),
  );
}

export function getAvailableCanvasTools(
  deviceMode: EffectiveDeviceMode,
): CanvasTool[] {
  return deviceMode === 'touch' ? ['lasso'] : ['select', 'pan', 'lasso'];
}

export function resolveCanvasToolShortcut(
  tool: CanvasTool,
  deviceMode: EffectiveDeviceMode,
): CanvasTool {
  return deviceMode === 'touch' && tool !== 'lasso' ? 'select' : tool;
}

export function resolveNodeDraggable(
  draggable: boolean | undefined,
  selected: boolean | undefined,
  deviceMode: EffectiveDeviceMode,
): boolean | undefined {
  return deviceMode === 'touch' && selected !== true ? false : draggable;
}

export function canPlaceNodeWithPointer(
  pointerType: string,
  deviceMode: EffectiveDeviceMode,
  touchInteractionMode: EffectiveTouchInteractionMode,
): boolean {
  if (pointerType === 'mouse') return false;
  if (deviceMode === 'desktop') return true;
  return touchInteractionMode === 'pen'
    ? pointerType === 'pen'
    : pointerType === 'touch';
}

export function isEmptyCanvasPlacementTarget(target: Element): boolean {
  return isEmptyPaneTarget(target);
}

export function isNodePlacementTap(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  activationDistance: number,
): boolean {
  return Math.hypot(endX - startX, endY - startY) < activationDistance;
}
