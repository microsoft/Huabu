/**
 * Global Cmd+F / Ctrl+F dispatcher for canvas search.
 *
 * Dispatches based on **focus location** rather than expanded-panel
 * state so the gesture matches user intuition: if you press Cmd+F
 * while typing inside the open preview, the in-preview search bar
 * pops up; if you press it anywhere else on the canvas, the canvas-
 * wide overlay opens.
 *
 * Mechanism:
 *   Each container that wants its own scope sets
 *   `data-search-scope="canvas" | "node"` on its root element. We walk
 *   up from `document.activeElement` to find the nearest such ancestor
 *   and dispatch accordingly. If neither is found we open the canvas
 *   scope by default (so Cmd+F always does *something*).
 *
 * Bypass:
 *   When focus is inside a native `<input>` / `<textarea>` /
 *   contenteditable, browser's built-in find-in-text is the wrong
 *   target — we still steal Cmd+F because our overlay subsumes the
 *   browser one for the canvas surface, and the native one would
 *   only find DOM text (not PDF body, not collapsed nodes). The
 *   user can hit Esc to close ours and fall back to the page native
 *   if they really need it.
 */

import { useEffect } from 'react';

import useCanvasStore from '../store/canvasStore';
import { useSearchStore } from '../store/searchStore';

type SearchScopeAttr = 'canvas' | 'node';

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

export function useGlobalSearchHotkey(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const isCmd = e.metaKey || e.ctrlKey;
      if (!isCmd || e.key.toLowerCase() !== 'f') return;
      // Don't steal Cmd+F + modifier combos used by other tools.
      if (e.altKey || e.shiftKey) return;

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
        useSearchStore
          .getState()
          .open({ kind: 'node', canvasId, nodeId: resolved.nodeId });
        return;
      }

      useSearchStore.getState().open({ kind: 'canvas', canvasId });
    };

    // Capture phase so we win against textarea / contenteditable
    // handlers that might consume Cmd+F for their own purposes.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
