// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

let frozen = false;

export function isDesktopInputFrozen(): boolean {
  return frozen;
}

export function setDesktopInputFrozen(value: boolean): void {
  frozen = value;
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
