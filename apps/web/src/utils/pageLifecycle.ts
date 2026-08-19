// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

let pageUnloading = false;

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    pageUnloading = true;
  });
  window.addEventListener('pageshow', () => {
    pageUnloading = false;
  });
}

export function isPageUnloading(): boolean {
  return pageUnloading;
}
