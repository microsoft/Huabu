// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

type PreviewSearchNavigator = {
  query: string;
  canNavigate: boolean;
  navigateToMatch: (matchIndex: number) => void;
};

type PendingNavigation = {
  query: string;
  matchIndex: number;
  onTimeout?: () => void;
  timer: ReturnType<typeof setTimeout>;
};

const navigators = new Map<string, PreviewSearchNavigator>();
const pendingNavigations = new Map<string, PendingNavigation>();

function tryPendingNavigation(nodeId: string): void {
  const navigator = navigators.get(nodeId);
  const pending = pendingNavigations.get(nodeId);
  if (
    !navigator ||
    !pending ||
    !navigator.canNavigate ||
    navigator.query !== pending.query
  ) {
    return;
  }

  clearTimeout(pending.timer);
  pendingNavigations.delete(nodeId);
  navigator.navigateToMatch(pending.matchIndex);
}

export function registerPreviewSearchNavigator(
  nodeId: string,
  navigator: PreviewSearchNavigator,
): () => void {
  navigators.set(nodeId, navigator);
  tryPendingNavigation(nodeId);
  return () => {
    if (navigators.get(nodeId) === navigator) navigators.delete(nodeId);
  };
}

export function schedulePreviewSearchNavigation(
  nodeId: string,
  query: string,
  matchIndex: number,
  options?: { timeoutMs?: number; onTimeout?: () => void },
): () => void {
  const previous = pendingNavigations.get(nodeId);
  if (previous) clearTimeout(previous.timer);

  const pending: PendingNavigation = {
    query,
    matchIndex,
    onTimeout: options?.onTimeout,
    timer: setTimeout(() => {
      if (pendingNavigations.get(nodeId) !== pending) return;
      pendingNavigations.delete(nodeId);
      pending.onTimeout?.();
    }, options?.timeoutMs ?? 8000),
  };
  pendingNavigations.set(nodeId, pending);
  tryPendingNavigation(nodeId);

  return () => {
    if (pendingNavigations.get(nodeId) !== pending) return;
    clearTimeout(pending.timer);
    pendingNavigations.delete(nodeId);
  };
}
