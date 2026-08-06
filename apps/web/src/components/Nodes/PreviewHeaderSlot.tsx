// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Slot mechanism that lets a preview component inject controls into
 * the chrome of its hosting panel (currently `ExpandedNodePanel`).
 *
 * The host provides a DOM element through the context; nested preview
 * components portal their action UI into that element via `react-dom`.
 * Using a real DOM element + portal keeps the React tree intact
 * (state, effects, event handlers all live with the preview) while the
 * rendered output appears inside the header bar.
 *
 * If no host is mounted (e.g. preview rendered in some future surface
 * that lacks a slot), `el` is `null` and consumers should simply skip
 * the portal — never throw.
 */

import { createContext, useContext } from 'react';

export interface PreviewHeaderSlotValue {
  /** Header DOM element to portal action buttons into, or null. */
  el: HTMLElement | null;
}

export const PreviewHeaderSlotContext = createContext<PreviewHeaderSlotValue>({
  el: null,
});

export function usePreviewHeaderSlot(): PreviewHeaderSlotValue {
  return useContext(PreviewHeaderSlotContext);
}
