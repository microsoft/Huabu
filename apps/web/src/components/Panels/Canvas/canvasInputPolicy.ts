import type {
  EffectiveDeviceMode,
  EffectiveTouchInteractionMode,
} from '@/store/toolStore';

export type CanvasTool = 'select' | 'pan' | 'lasso';

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
  return Boolean(
    target.closest('.react-flow__pane') &&
    !target.closest(
      '.react-flow__panel, .react-flow__node, .react-flow__edge, .react-flow__handle',
    ),
  );
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
