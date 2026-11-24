// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { desktopSpaceStorage } from '@/utils/desktopStorage';

interface PanelState {
  leftMode: 'layers' | 'files';
  filesLocation: { canvasId: string; agentletId: string; path: string } | null;
  /**
   * Last directory browsed per Space and device; see {@link filesPathKey}.
   * Entries are kept oldest first, so the order also records which device a
   * Space browsed last.
   */
  filesLastPaths: Record<string, string>;
  openFiles: (location: {
    canvasId: string;
    agentletId: string;
    path: string;
  }) => void;
  setLeftMode: (mode: 'layers' | 'files') => void;
  /**
   * Collapse state for the left (layer) side panel.
   *
   * Hoisted out of `MainLayout`'s local `useState` so subtrees inside
   * the column (notably `CanvasLayerPanel`) can read it and skip
   * expensive work while the overlay is offscreen — `MainLayout` keeps
   * the shell mounted and retains the ordinary tree through the 220ms
   * slide animation before allowing it to unmount.
   */
  isLeftCollapsed: boolean;
  setLeftCollapsed: (collapsed: boolean) => void;
  toggleLeftPanel: () => void;

  /** Pending focus nonce for the permanent Canvas search field. */
  focusCanvasSearchRequest: number | null;
  /** Expand Layers and request search focus after the DOM leaves its inert state. */
  requestFocusCanvasSearch: () => void;

  /** Pending one-shot request to bring a node's row into view in Layers. */
  layerLocateRequest: {
    nodeId: string;
    nonce: number;
    /** Layers is the only locator (Canvas hidden): reveal the row at any cost. */
    force: boolean;
  } | null;
  /**
   * Ask Layers to show a node's row. With `open` the panel is expanded on the
   * Layers tab first; without it the request is a no-op unless Layers is
   * already showing, so it never changes what the user has open.
   */
  requestLayerLocate: (nodeId: string, options?: { open?: boolean }) => void;
  consumeLayerLocateRequest: (nonce: number) => void;

  /**
   * Collapse state for the right (chat) panel. Hoisted out of
   * `MainLayout`'s local `useState` and persisted to localStorage so
   * a refresh / canvas re-entry keeps whatever open/closed state the
   * user last left the chat panel in. Defaults to `true` (closed) for
   * first-time users.
   */
  isRightCollapsed: boolean;
  /** Last manually resized Preview width, shared across Spaces on this device. */
  rightWidthPx: number;
  setRightWidthPx: (width: number) => void;
  /** Transient presentation mode; fullscreen never survives a reload. */
  isPreviewFullscreen: boolean;
  setPreviewFullscreen: (fullscreen: boolean) => void;
  togglePreviewFullscreen: () => void;
  setRightCollapsed: (collapsed: boolean) => void;
  toggleRightPanel: () => void;
  /**
   * Request the right (chat) panel to open. Kept as a named action
   * (instead of a bare `setRightCollapsed(false)` at every call site)
   * so the open-on-event intent reads clearly at the surface and so we
   * can layer extra behaviour here later (focus, scroll, telemetry)
   * without touching callers.
   */
  requestOpenRightPanel: () => void;

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

const MAX_REMEMBERED_FILE_PATHS = 100;

export const filesPathKey = (canvasId: string, agentletId: string) =>
  `${canvasId}\n${agentletId}`;

/** The device a Space browsed most recently, if it browsed any. */
export function lastFilesDevice(
  canvasId: string,
  filesLastPaths: Record<string, string>,
): string | undefined {
  const prefix = filesPathKey(canvasId, '');
  return Object.keys(filesLastPaths)
    .filter((key) => key.startsWith(prefix))
    .pop()
    ?.slice(prefix.length);
}

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      leftMode: 'layers',
      filesLocation: null,
      filesLastPaths: {},
      openFiles: (filesLocation) =>
        set((s) => {
          const key = filesPathKey(
            filesLocation.canvasId,
            filesLocation.agentletId,
          );
          // Re-insert so the oldest remembered directory is evicted first.
          const { [key]: _previous, ...others } = s.filesLastPaths;
          const entries = [
            ...Object.entries(others),
            [key, filesLocation.path] as const,
          ].slice(-MAX_REMEMBERED_FILE_PATHS);
          return {
            filesLocation,
            filesLastPaths: Object.fromEntries(entries),
            leftMode: 'files',
            isLeftCollapsed: false,
          };
        }),
      setLeftMode: (leftMode) => set({ leftMode }),
      isLeftCollapsed: true,
      setLeftCollapsed: (collapsed) => set({ isLeftCollapsed: collapsed }),
      toggleLeftPanel: () =>
        set((s) => ({ isLeftCollapsed: !s.isLeftCollapsed })),

      focusCanvasSearchRequest: null,
      requestFocusCanvasSearch: () =>
        set((s) => ({
          isLeftCollapsed: false,
          leftMode: 'layers',
          focusCanvasSearchRequest: (s.focusCanvasSearchRequest ?? 0) + 1,
        })),

      layerLocateRequest: null,
      requestLayerLocate: (nodeId, options) =>
        set((s) => {
          const showing = !s.isLeftCollapsed && s.leftMode === 'layers';
          if (!showing && !options?.open) return s;
          return {
            isLeftCollapsed: false,
            leftMode: 'layers',
            layerLocateRequest: {
              nodeId,
              nonce: (s.layerLocateRequest?.nonce ?? 0) + 1,
              force: !!options?.open,
            },
          };
        }),
      consumeLayerLocateRequest: (nonce) =>
        set((s) =>
          s.layerLocateRequest?.nonce === nonce
            ? { layerLocateRequest: null }
            : s,
        ),

      isRightCollapsed: true,
      rightWidthPx: 420,
      setRightWidthPx: (width) => set({ rightWidthPx: width }),
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
      setRightCollapsed: (collapsed) =>
        set({
          isRightCollapsed: collapsed,
          ...(collapsed ? { isPreviewFullscreen: false } : {}),
        }),
      toggleRightPanel: () =>
        set((s) => ({
          isRightCollapsed: !s.isRightCollapsed,
          ...(!s.isRightCollapsed ? { isPreviewFullscreen: false } : {}),
        })),
      requestOpenRightPanel: () =>
        set({
          isRightCollapsed: false,
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
      storage: createJSONStorage(desktopSpaceStorage),
      // Preview's open state and preferred width persist. `isLeftCollapsed`
      // stays per-session (always collapsed on fresh load — matches the
      // pre-persist default), and focus requests stay transient.
      partialize: (state) => ({
        isRightCollapsed: state.isRightCollapsed,
        rightWidthPx: state.rightWidthPx,
        filesLastPaths: state.filesLastPaths,
      }),
    },
  ),
);
