// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const fontSubscribers = new Set<() => void>();
let stopFontObservation: (() => void) | undefined;

/** Share one font listener across labels, releasing it when none need measurement. */
export function subscribeToFontChanges(measure: () => void) {
  const fonts = document.fonts;
  if (!fonts) return () => {};
  fontSubscribers.add(measure);
  if (!stopFontObservation) {
    let active = true;
    const refresh = () => {
      if (active) fontSubscribers.forEach((subscriber) => subscriber());
    };
    fonts.addEventListener('loadingdone', refresh);
    void fonts.ready.then(refresh);
    stopFontObservation = () => {
      active = false;
      fonts.removeEventListener('loadingdone', refresh);
    };
  }
  return () => {
    fontSubscribers.delete(measure);
    if (fontSubscribers.size === 0) {
      stopFontObservation?.();
      stopFontObservation = undefined;
    }
  };
}
