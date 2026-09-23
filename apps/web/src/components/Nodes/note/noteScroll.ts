// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export function canScrollNote({
  selected,
  selectedCount,
  fixed,
  bodyVisible,
  missing,
}: {
  selected: boolean;
  selectedCount: number;
  fixed: boolean;
  bodyVisible: boolean;
  missing: boolean;
}) {
  return selected && selectedCount === 1 && fixed && bodyVisible && !missing;
}

/** Native capture listener runs before React Flow's bubbling wheel handler.
 * Keep pinch/modifier gestures canvas-owned; contain plain scrolling even
 * at the document edges without cancelling the browser's native scroll. */
export function containNoteWheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const viewport = event.currentTarget as HTMLElement;
  if (viewport.scrollHeight <= viewport.clientHeight + 1) return;
  event.stopPropagation();
}
