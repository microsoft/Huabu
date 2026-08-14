// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PanelState {
  /**
   * Collapse state for the left (layer) side panel.
   *
   * Hoisted out of `MainLayout`'s local `useState` so subtrees inside
   * the column (notably `CanvasLayerPanel`) can read it and skip
   * expensive work while the column animates to 0 — `MainLayout` keeps
   * the subtree mounted on purpose so its 220ms width animation runs
   * without a content-swap flash.
   */
  isLeftCollapsed: boolean;
  setLeftCollapsed: (collapsed: boolean) => void;
  toggleLeftPanel: () => void;

  /**
   * Whether the canvas-wide search input is revealed in the left
   * layer panel. Default `false` so the panel chrome stays quiet
   * for users who never search; flipped to `true` by the search
   * icon in `LayerFilterBar`, by `Cmd+F`, or by any other entry
   * point that needs the input focused. Lives in this global store
   * because the toggle is driven from multiple, non-adjacent
   * surfaces (toolbar button, hotkey, future API), and the
   * `CanvasSearchInput` component is mounted only while this is
   * `true` so its auto-focus / cleanup run on every reveal. Opening
   * search expands the panel once; later manual collapse is respected
   * without closing or clearing the search session.
   */
  isSearchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  toggleSearchOpen: () => void;

  /**
   * Collapse state for the right (chat) panel. Hoisted out of
   * `MainLayout`'s local `useState` and persisted to localStorage so
   * a refresh / canvas re-entry keeps whatever open/closed state the
   * user last left the chat panel in. Defaults to `true` (closed) for
   * first-time users.
   */
  isRightCollapsed: boolean;
  /** Transient presentation mode; fullscreen never survives a reload. */
  isPreviewFullscreen: boolean;
  setPreviewFullscreen: (fullscreen: boolean) => void;
  togglePreviewFullscreen: () => void;
  /** Node explicitly associated with the action that opened Chat. */
  rightPanelAnchorNodeId: string | null;
  clearRightPanelAnchor: () => void;
  setRightCollapsed: (collapsed: boolean) => void;
  toggleRightPanel: () => void;
  /**
   * Request the right (chat) panel to open. Kept as a named action
   * (instead of a bare `setRightCollapsed(false)` at every call site)
   * so the open-on-event intent reads clearly at the surface and so we
   * can layer extra behaviour here later (focus, scroll, telemetry)
   * without touching callers.
   */
  requestOpenRightPanel: (anchorNodeId?: string) => void;

  /**
   * The outstanding request to focus a composer, or `null` if none.
   *
   * Named to a thread so a request meant for the Chat a question node just
   * opened cannot steal focus from another Chat on screen. The nonce lets
   * repeated requests for the same thread re-fire focus without a reset.
   */
  focusChatInputRequest: { threadId: string; nonce: number } | null;
  /** Request that the composer bound to `threadId` take focus. */
  requestFocusChatInput: (threadId: string) => void;
}

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      isLeftCollapsed: true,
      setLeftCollapsed: (collapsed) => set({ isLeftCollapsed: collapsed }),
      toggleLeftPanel: () =>
        set((s) => ({ isLeftCollapsed: !s.isLeftCollapsed })),

      isSearchOpen: false,
      setSearchOpen: (open) =>
        set({
          isSearchOpen: open,
          ...(open ? { isLeftCollapsed: false } : {}),
        }),
      toggleSearchOpen: () =>
        set((s) => ({
          isSearchOpen: !s.isSearchOpen,
          ...(!s.isSearchOpen ? { isLeftCollapsed: false } : {}),
        })),

      isRightCollapsed: true,
      isPreviewFullscreen: false,
      setPreviewFullscreen: (fullscreen) =>
        set({
          isPreviewFullscreen: fullscreen,
          ...(fullscreen ? { isRightCollapsed: false } : {}),
        }),
      togglePreviewFullscreen: () =>
        set((s) => ({
          isPreviewFullscreen: !s.isPreviewFullscreen,
          ...(!s.isPreviewFullscreen ? { isRightCollapsed: false } : {}),
        })),
      rightPanelAnchorNodeId: null,
      clearRightPanelAnchor: () => set({ rightPanelAnchorNodeId: null }),
      setRightCollapsed: (collapsed) =>
        set({
          isRightCollapsed: collapsed,
          ...(collapsed ? { isPreviewFullscreen: false } : {}),
          rightPanelAnchorNodeId: null,
        }),
      toggleRightPanel: () =>
        set((s) => ({
          isRightCollapsed: !s.isRightCollapsed,
          ...(!s.isRightCollapsed ? { isPreviewFullscreen: false } : {}),
          rightPanelAnchorNodeId: null,
        })),
      requestOpenRightPanel: (anchorNodeId) =>
        set({
          isRightCollapsed: false,
          rightPanelAnchorNodeId: anchorNodeId ?? null,
        }),

      focusChatInputRequest: null,
      requestFocusChatInput: (threadId) =>
        set((s) => ({
          focusChatInputRequest: {
            threadId,
            nonce: (s.focusChatInputRequest?.nonce ?? 0) + 1,
          },
        })),
    }),
    {
      name: 'huabu-panel',
      // Only the chat panel's open state is persisted. `isLeftCollapsed`
      // stays per-session (always collapsed on fresh load — matches the
      // pre-persist default) and `isSearchOpen` is intentionally
      // transient.
      partialize: (state) => ({
        isRightCollapsed: state.isRightCollapsed,
      }),
    },
  ),
);
