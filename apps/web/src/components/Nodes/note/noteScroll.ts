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

/** Match the native lane's 8px end insets and 24px minimum thumb. */
export function noteScrollIndicator(
  scrollTop: number,
  viewportHeight: number,
  contentHeight: number,
) {
  const trackHeight = viewportHeight - 16;
  const maxScroll = contentHeight - viewportHeight;
  if (trackHeight <= 0 || maxScroll <= 1) return null;
  const height = Math.min(
    trackHeight,
    Math.max(24, (trackHeight * viewportHeight) / contentHeight),
  );
  const progress = Math.min(1, Math.max(0, scrollTop / maxScroll));
  return {
    height: `${(height / trackHeight) * 100}%`,
    top: `${((progress * (trackHeight - height)) / trackHeight) * 100}%`,
  };
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
