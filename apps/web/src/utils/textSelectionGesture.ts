// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Hold selection chrome until release, including a release outside the surface. */
export function trackTextSelectionGesture(
  surface: HTMLElement,
  onStart: () => void,
  onEnd: (event: MouseEvent | null) => void,
): () => void {
  const doc = surface.ownerDocument;
  const win = doc.defaultView;
  let selecting = false;
  const isContent = (target: EventTarget | null) =>
    target instanceof Node &&
    surface.contains(target) &&
    !(target instanceof Element && target.closest('[data-floating-chrome]'));
  const start = (event: MouseEvent) => {
    if (event.button !== 0 || !isContent(event.target)) return;
    selecting = true;
    onStart();
  };
  const end = (event: MouseEvent) => {
    if (event.button !== 0 || (!selecting && !isContent(event.target))) return;
    selecting = false;
    onEnd(event);
  };
  const cancel = () => {
    if (!selecting) return;
    selecting = false;
    onEnd(null);
  };
  const visibility = () => {
    if (doc.hidden) cancel();
  };
  surface.addEventListener('mousedown', start, true);
  doc.addEventListener('mouseup', end, true);
  doc.addEventListener('dragend', cancel, true);
  win?.addEventListener('blur', cancel);
  doc.addEventListener('visibilitychange', visibility);
  return () => {
    surface.removeEventListener('mousedown', start, true);
    doc.removeEventListener('mouseup', end, true);
    doc.removeEventListener('dragend', cancel, true);
    win?.removeEventListener('blur', cancel);
    doc.removeEventListener('visibilitychange', visibility);
  };
}
