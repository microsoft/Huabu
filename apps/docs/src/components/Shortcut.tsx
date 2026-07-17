// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * OS-aware keyboard-shortcut chip. Renders a shortcut in the same boxed
 * {@link Kbd} style used across the docs, picking the right notation for the
 * reader's platform — `⌘,` / `⇧⌘Z` on macOS, `Ctrl+,` / `Ctrl+Shift+Z`
 * elsewhere — so every surface (body copy, the Search trigger) shows one
 * consistent representation instead of the old hand-written
 * `⌘, (Ctrl+, on Windows)`.
 *
 * The pages are prerendered in Node and hydrated in the browser, so platform
 * detection must run *after* mount to avoid a hydration mismatch: the first
 * client render matches the server (non-mac), then {@link useIsMac} flips it.
 */

import { useEffect, useState } from 'react';

import { Kbd } from './Code';

/** Canonical modifier tokens accepted in a {@link Shortcut} `combo`. */
type Modifier = 'mod' | 'shift' | 'alt' | 'meta';

const MAC_SYMBOL: Record<Modifier, string> = {
  mod: '⌘',
  shift: '⇧',
  alt: '⌥',
  meta: '⌘',
};

const OTHER_LABEL: Record<Modifier, string> = {
  mod: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Win',
};

const isModifier = (part: string): part is Modifier => part in MAC_SYMBOL;

/**
 * `true` when the reader is on macOS. Defaults to `false` during SSR and the
 * first hydration render, then resolves on the client to keep markup stable.
 */
function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent;
    setIsMac(/Mac|iPhone|iPad|iPod/.test(navigator.platform || ua));
  }, []);
  return isMac;
}

/**
 * Render `combo` (a `+`-separated string like `mod+,` or `mod+shift+z`) as a
 * platform-appropriate shortcut chip. Modifiers are mapped per OS; any other
 * token is treated as a literal key (upper-cased when a single letter). macOS
 * joins parts with no separator (`⇧⌘Z`); other platforms use `+`
 * (`Ctrl+Shift+Z`).
 */
export function Shortcut({ combo }: { combo: string }) {
  const isMac = useIsMac();

  const parts = combo.split('+').map((raw) => {
    const part = raw.trim();
    if (isModifier(part)) return isMac ? MAC_SYMBOL[part] : OTHER_LABEL[part];
    return part.length === 1 ? part.toUpperCase() : part;
  });

  return <Kbd>{parts.join(isMac ? '' : '+')}</Kbd>;
}
