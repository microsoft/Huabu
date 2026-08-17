// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { PreviewTarget } from './model';

const scrollTopByViewKey = new Map<string, number>();
const registrationByTarget = new Map<
  string,
  { canvasId: string; viewKey: string }
>();
const referenceCountByViewKey = new Map<string, number>();

export function previewTargetKey(target: PreviewTarget): string {
  return JSON.stringify(
    target.kind === 'chat'
      ? [target.kind, target.canvasId, target.threadId]
      : [target.kind, target.canvasId, target.nodeId],
  );
}

function addReference(viewKey: string): void {
  referenceCountByViewKey.set(
    viewKey,
    (referenceCountByViewKey.get(viewKey) ?? 0) + 1,
  );
}

function removeReference(viewKey: string): void {
  const next = (referenceCountByViewKey.get(viewKey) ?? 0) - 1;
  if (next > 0) {
    referenceCountByViewKey.set(viewKey, next);
    return;
  }
  referenceCountByViewKey.delete(viewKey);
  scrollTopByViewKey.delete(viewKey);
}

export function messageListViewKey(
  ownerCanvasId: string,
  threadId: string,
): string {
  return `${ownerCanvasId}:${threadId}`;
}

export function rememberMessageListScrollPosition(
  viewKey: string | undefined,
  scrollTop: number,
): void {
  if (!viewKey || !Number.isFinite(scrollTop)) return;
  scrollTopByViewKey.set(viewKey, Math.max(0, scrollTop));
}

export function restoreMessageListScrollPosition(
  container: HTMLElement,
  viewKey: string | undefined,
): boolean {
  if (!viewKey) return false;
  const scrollTop = scrollTopByViewKey.get(viewKey);
  if (scrollTop === undefined) return false;
  container.scrollTop = scrollTop;
  return true;
}

export function registerMessageListScrollTarget(
  target: PreviewTarget,
  viewKey: string,
): void {
  if (!viewKey) return;
  const key = previewTargetKey(target);
  const previous = registrationByTarget.get(key);
  if (previous?.viewKey === viewKey) return;
  registrationByTarget.set(key, {
    canvasId: target.canvasId,
    viewKey,
  });
  addReference(viewKey);
  if (previous) removeReference(previous.viewKey);
}

export function forgetMessageListScrollPosition(
  viewKey: string | undefined,
): void {
  if (!viewKey) return;
  for (const [key, registration] of registrationByTarget) {
    if (registration.viewKey !== viewKey) continue;
    registrationByTarget.delete(key);
    removeReference(viewKey);
  }
  scrollTopByViewKey.delete(viewKey);
}

export function forgetMessageListScrollTarget(target: PreviewTarget): void {
  const key = previewTargetKey(target);
  const registration = registrationByTarget.get(key);
  registrationByTarget.delete(key);
  if (registration) removeReference(registration.viewKey);
}

export function replaceMessageListScrollTarget(
  previousTarget: PreviewTarget,
  nextTarget: PreviewTarget,
): void {
  const previousKey = previewTargetKey(previousTarget);
  const nextKey = previewTargetKey(nextTarget);
  if (previousKey === nextKey) return;

  const previous = registrationByTarget.get(previousKey);
  if (!previous) return;
  registrationByTarget.delete(previousKey);

  if (registrationByTarget.has(nextKey)) {
    removeReference(previous.viewKey);
    return;
  }
  registrationByTarget.set(nextKey, {
    canvasId: nextTarget.canvasId,
    viewKey: previous.viewKey,
  });
}

export function forgetMessageListScrollCanvas(canvasId: string): void {
  if (!canvasId) return;
  const removedViewKeys = new Set<string>();
  for (const [key, registration] of registrationByTarget) {
    if (registration.canvasId !== canvasId) continue;
    registrationByTarget.delete(key);
    removedViewKeys.add(registration.viewKey);
    removeReference(registration.viewKey);
  }

  const viewKeyPrefix = `${canvasId}:`;
  for (const viewKey of scrollTopByViewKey.keys()) {
    if (viewKey.startsWith(viewKeyPrefix)) removedViewKeys.add(viewKey);
  }
  for (const viewKey of removedViewKeys) {
    if (!referenceCountByViewKey.has(viewKey))
      scrollTopByViewKey.delete(viewKey);
  }
}
