// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  MOUSE_DRAG_ACTIVATION_PX,
  PEN_DRAG_ACTIVATION_PX,
  TOUCH_DRAG_ACTIVATION_PX,
} from '@/config/canvas';

export type CanvasGestureKind =
  | 'touch-pan'
  | 'lasso'
  | 'sketch-stroke-move'
  | 'sketch-draw'
  | 'sketch-erase';
export type CanvasGesturePhase = 'pending' | 'locked';
export type CanvasPointerType = 'mouse' | 'pen' | 'touch';

type Point = { x: number; y: number };

type CanvasGestureSession = {
  kind: CanvasGestureKind;
  pointerId: number;
  pointerType: CanvasPointerType;
  start: Point;
  phase: CanvasGesturePhase;
};

let activeSession: CanvasGestureSession | null = null;

export function getDragActivationDistance(pointerType: string): number {
  if (pointerType === 'touch') return TOUCH_DRAG_ACTIVATION_PX;
  if (pointerType === 'pen') return PEN_DRAG_ACTIVATION_PX;
  return MOUSE_DRAG_ACTIVATION_PX;
}

export function beginCanvasGesture(
  kind: CanvasGestureKind,
  pointerId: number,
  pointerType: CanvasPointerType,
  start: Point,
): boolean {
  if (activeSession) return false;
  activeSession = { kind, pointerId, pointerType, start, phase: 'pending' };
  return true;
}

export function updateCanvasGesture(
  pointerId: number,
  point: Point,
): CanvasGesturePhase | null {
  if (!activeSession || activeSession.pointerId !== pointerId) return null;
  if (activeSession.phase === 'locked') return 'locked';

  const moved = Math.hypot(
    point.x - activeSession.start.x,
    point.y - activeSession.start.y,
  );
  if (moved >= getDragActivationDistance(activeSession.pointerType)) {
    activeSession.phase = 'locked';
  }
  return activeSession.phase;
}

export function getCanvasGesture(): Readonly<CanvasGestureSession> | null {
  return activeSession;
}

export function canTouchTakeOverCanvasGesture(): boolean {
  return (
    activeSession === null ||
    activeSession.kind === 'touch-pan' ||
    activeSession.phase === 'pending'
  );
}

export function endCanvasGesture(pointerId: number): boolean {
  if (!activeSession || activeSession.pointerId !== pointerId) return false;
  activeSession = null;
  return true;
}

export function cancelPendingCanvasGesture(): boolean {
  if (!activeSession || activeSession.phase !== 'pending') return false;
  activeSession = null;
  return true;
}

export function resetCanvasGestureForTests(): void {
  activeSession = null;
}
