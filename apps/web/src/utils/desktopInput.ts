// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

let frozen = false;
let restoreFreeze: (() => void) | undefined;
let deletionFreeze = false;

export function isDesktopInputFrozen(): boolean {
  return frozen;
}

export function setDesktopInputFrozen(
  value: boolean,
  reason?: 'space-deletion',
): void {
  restoreFreeze?.();
  restoreFreeze = undefined;
  frozen = value;
  deletionFreeze = value && reason === 'space-deletion';
  if (deletionFreeze) {
    const previous = new Map<HTMLElement, boolean>();
    const freezeChildren = () => {
      for (const child of document.body.children) {
        if (!(child instanceof HTMLElement)) continue;
        if (
          child.matches(
            '[data-desktop-deletion-dialog], dialog[data-desktop-close-controls]',
          )
        )
          continue;
        if (!previous.has(child)) previous.set(child, child.inert);
        child.inert = true;
      }
    };
    document.body.inert = false;
    freezeChildren();
    const observer = new MutationObserver(freezeChildren);
    observer.observe(document.body, { childList: true });
    restoreFreeze = () => {
      observer.disconnect();
      for (const [child, inert] of previous) child.inert = inert;
    };
    return;
  }
  // Body includes React portals, unlike the router-root subtree.
  document.body.inert = value;
}

export function installDesktopInputGuard(): () => void {
  const events = [
    'keydown',
    'keyup',
    'beforeinput',
    'click',
    'dblclick',
    'paste',
    'cut',
    'drop',
    'change',
    'submit',
    'pointerdown',
    'pointermove',
    'pointerup',
    'mousedown',
    'mousemove',
    'mouseup',
    'touchstart',
    'touchmove',
    'touchend',
    'wheel',
    'contextmenu',
  ] as const;
  const block = (event: Event) => {
    if (!frozen) return;
    if (
      event.target instanceof Element &&
      event.target.closest('dialog[data-desktop-close-controls][open]')
    )
      return;
    if (
      deletionFreeze &&
      event.target instanceof Element &&
      event.target.closest('[data-desktop-deletion-dialog]')
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const event of events)
    window.addEventListener(event, block, { capture: true, passive: false });
  return () => {
    for (const event of events) window.removeEventListener(event, block, true);
    setDesktopInputFrozen(false);
  };
}
