// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Global Cmd+F / Ctrl+F dispatcher for canvas search.
 *
 * Dispatches based on **focus location** rather than expanded-panel
 * state so the gesture matches user intuition:
 *
 *   - Focus inside an open preview (`data-search-scope="node"`)
 *     → open preview-local find without changing canvas search.
 *   - Focus inside the canvas (`data-search-scope="canvas"`) or
 *     anywhere else → make sure the canvas-wide search input in
 *     the left layer panel is focused, the panel is expanded, and
 *     the search store has a `{kind:'canvas', canvasId}` scope so
 *     typing immediately fires a query.
 *
 * Bypass:
 *   When focus is inside a native `<input>` / `<textarea>` /
 *   contenteditable, browser's built-in find-in-text is the wrong
 *   target — we still steal Cmd+F because our search subsumes the
 *   browser one for the canvas surface, and the native one would
 *   only find DOM text (not PDF body, not collapsed nodes). The
 *   user can hit Esc to dismiss ours and fall back to the page
 *   native if they really need it.
 */

import { useEffect } from 'react';

import { ensureCanvasSearchScope } from '../components/Panels/CanvasLayerPanel/CanvasSearchInput';
import { matchesShortcut } from '../config/shortcuts';
import useCanvasStore from '../store/canvasStore';
import { usePanelStore } from '../store/panelStore';
import { usePreviewSearchStore } from '../store/previewSearchStore';

type SearchScopeAttr = 'canvas' | 'node';

/** DOM hook the in-panel `CanvasSearchInput` tags on its `<input>`. */
const CANVAS_SEARCH_INPUT_SELECTOR = 'input[data-canvas-search-input="true"]';

function resolveScopeFromFocus(active: Element | null): SearchScopeAttr | null {
  if (!active) return null;
  // `closest` walks up through ancestors *and* includes `active` itself.
  const matched = active.closest('[data-search-scope]');
  if (!matched) return null;
  const value = matched.getAttribute('data-search-scope');
  if (value === 'canvas' || value === 'node') return value;
  return null;
}

function resolveNodeIdFromFocus(active: Element | null): string | null {
  if (!active) return null;
  const matched = active.closest('[data-search-scope="node"]');
  if (!matched) return null;
  return matched.getAttribute('data-search-node-id');
}

/**
 * When no node-scope ancestor is found from focus (e.g. focus is on
 * `<body>` because the PDF / react-pdf viewer hasn't taken focus),
 * fall back to any currently-mounted expanded-preview panel. Only one
 * `data-search-scope="node"` is ever mounted at a time, so this is
 * an unambiguous DOM probe.
 */
function findMountedNodeScope(): {
  scope: 'node';
  nodeId: string | null;
} | null {
  const el = document.querySelector('[data-search-scope="node"]');
  if (!el) return null;
  return { scope: 'node', nodeId: el.getAttribute('data-search-node-id') };
}

/**
 * Auto-expand the left panel (if collapsed), reveal the canvas-
 * wide search input (panel-side `isSearchOpen=true` triggers its
 * mount), and as a safety net focus the input once it has rendered.
 *
 * `CanvasSearchInput` auto-focuses itself on mount so this rAF
 * focus retry is only needed when the component was already
 * mounted (re-press of Cmd+F while open) or when the panel was
 * still animating open at the moment React rendered.
 */
function focusCanvasSearchInput(canvasId: string): void {
  usePanelStore.getState().setLeftCollapsed(false);
  usePanelStore.getState().setSearchOpen(true);
  ensureCanvasSearchScope(canvasId);
  const tryFocus = (): boolean => {
    const input = document.querySelector<HTMLInputElement>(
      CANVAS_SEARCH_INPUT_SELECTOR,
    );
    if (!input) return false;
    input.focus();
    input.select();
    return true;
  };
  if (!tryFocus()) {
    // The panel column animates open over ~220ms; rAF on the next
    // frame is usually enough because the inner subtree is already
    // mounted (only the column width animates). One retry, no loop
    // — if both attempts fail the user can just press Cmd+F again.
    requestAnimationFrame(() => {
      tryFocus();
    });
  }
}

export function useGlobalSearchHotkey(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // Cmd/Ctrl+F only — sourced from the shared shortcut catalog.
      // `matches` also rejects the extra Alt/Shift combos other tools use.
      if (!matchesShortcut(e, 'search.open')) return;

      const active = document.activeElement;
      const focusScope = resolveScopeFromFocus(active);
      const canvasId = useCanvasStore.getState().canvasId;
      if (!canvasId) return;

      e.preventDefault();

      // Prefer focus scope when it resolves. Otherwise, if an expanded
      // preview panel is mounted (e.g. PDF view where focus stays on
      // `<body>` because the embedded viewer doesn't accept keyboard
      // focus), route Cmd+F to that panel rather than defaulting to
      // canvas — the user almost certainly meant to search inside what
      // they're looking at.
      const resolved = focusScope
        ? focusScope === 'node'
          ? { scope: 'node' as const, nodeId: resolveNodeIdFromFocus(active) }
          : { scope: 'canvas' as const }
        : (findMountedNodeScope() ?? { scope: 'canvas' as const });

      if (resolved.scope === 'node' && resolved.nodeId) {
        usePreviewSearchStore.getState().open(resolved.nodeId);
        return;
      }

      focusCanvasSearchInput(canvasId);
    };

    // Capture phase so we win against textarea / contenteditable
    // handlers that might consume Cmd+F for their own purposes.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
