// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import { SKETCH_ERASER_RADIUS_SCREEN_PX } from '@/config/canvas';
import { persistApplicationPreferences } from '@/utils/applicationPreferenceStore';

import type { CanvasNodeType } from '@huabu/shared';

/**
 * Node type awaiting placement on canvas via click or drawing.
 *
 * Derived from `CanvasNodeType` minus the upload-only kinds
 * (`image` / `pdf` / `video` / `web`), which never enter the canvas
 * through the toolbar's click-to-place flow. Expressing this as a
 * subset of the shared canvas-node union means adding a new canvas
 * node type will force a TS decision here, instead of silently
 * leaving the toolbar out of sync.
 * `childSpace` is a creation action that places a canonical Space entry,
 * not a separate persisted node type.
 */
export type PendingNodeType =
  | 'childSpace'
  | Exclude<CanvasNodeType, 'image' | 'pdf' | 'video' | 'web'>
  | null;

/**
 * Active sketch tool settings — color, thickness, and tool mode used by
 * the live SketchOverlay preview and persisted onto each new sketch node
 * so the same look replays after reload. Per-node values are still
 * editable after-the-fact via the sketch node's toolbar.
 *
 * `mode` switches the overlay between drawing new strokes (`'draw'`) and
 * erasing existing sketch nodes (`'erase'`).
 */
export type SketchDraft = {
  strokeColor: string;
  strokeSize: number;
  /**
   * Eraser brush radius (screen-space px) used by the sketch tool's
   * erase mode. Independent of `strokeSize` so changing the eraser
   * size doesn't disturb the active draw thickness, and vice versa.
   */
  eraserSize: number;
  mode: 'draw' | 'erase';
};

export type SketchSizePresetKind = 'stroke' | 'eraser';
export type SketchSizePresets = [number, number, number];
export type SketchColorPresets = [string, string, string];

export type InputModePreference = 'auto' | 'mouse' | 'pen' | 'finger';
export type EffectiveInputMode = Exclude<InputModePreference, 'auto'>;
export type CanvasTool = 'select' | 'pan' | 'lasso';

export function resolveInputMode(
  preference: InputModePreference,
  touchCapable: boolean,
  penObserved: boolean,
): EffectiveInputMode {
  if (preference !== 'auto') return preference;
  if (penObserved) return 'pen';
  return touchCapable ? 'finger' : 'mouse';
}

type ToolState = {
  pendingNodeType: PendingNodeType;
  mouseToolPreference: CanvasTool;
  explicitLassoActive: boolean;
  toolIntent: number;
  chooseCanvasTool: (tool: CanvasTool, isNotMouse: boolean) => void;
  togglePendingNodeType: (type: Exclude<PendingNodeType, null>) => void;
  finishPendingNodeType: (intent: number) => boolean;
  sketchDraft: SketchDraft;
  colorPresets: SketchColorPresets;
  strokeSizePresets: SketchSizePresets;
  eraserSizePresets: SketchSizePresets;
  activeColorPreset: number;
  activeStrokeSizePreset: number;
  activeEraserSizePreset: number;
  inputModePreference: InputModePreference;
  penObserved: boolean;
  setPendingNodeType: (type: PendingNodeType) => void;
  setSketchDraft: (patch: Partial<SketchDraft>) => void;
  setInputModePreference: (preference: InputModePreference) => void;
  observePen: () => void;
  selectSketchColorPreset: (index: number) => void;
  updateSketchColorPreset: (index: number, color: string) => void;
  selectSketchSizePreset: (kind: SketchSizePresetKind, index: number) => void;
  updateSketchSizePreset: (
    kind: SketchSizePresetKind,
    index: number,
    value: number,
  ) => void;
  /**
   * Called when canvasStore changes Space identity to retire transient
   * placement and Lasso intent, including stale completion callbacks.
   *
   * `sketchDraft` is intentionally NOT reset — users expect their
   * brush color/size to persist across canvases.
   */
  resetForCanvasSwitch: () => void;
};

const DEFAULT_SKETCH_DRAFT: SketchDraft = {
  strokeColor: 'black',
  strokeSize: 8,
  eraserSize: SKETCH_ERASER_RADIUS_SCREEN_PX,
  mode: 'draw',
};

const DEFAULT_STROKE_SIZE_PRESETS: SketchSizePresets = [4, 8, 16];
const DEFAULT_ERASER_SIZE_PRESETS: SketchSizePresets = [
  SKETCH_ERASER_RADIUS_SCREEN_PX,
  24,
  40,
];
const DEFAULT_COLOR_PRESETS: SketchColorPresets = ['black', 'red', 'blue'];

const DEFAULT_TOOL_PREFERENCES = {
  sketchDraft: DEFAULT_SKETCH_DRAFT,
  colorPresets: DEFAULT_COLOR_PRESETS,
  strokeSizePresets: DEFAULT_STROKE_SIZE_PRESETS,
  eraserSizePresets: DEFAULT_ERASER_SIZE_PRESETS,
  activeColorPreset: 0,
  activeStrokeSizePreset: 1,
  activeEraserSizePreset: 0,
  inputModePreference: 'auto',
  penObserved: false,
  mouseToolPreference: 'select',
} satisfies Partial<ToolState>;

function readMouseToolPreference(value: unknown): CanvasTool {
  if (value === undefined) return 'select';
  if (value === 'select' || value === 'pan' || value === 'lasso') return value;
  console.error('[preferences] Invalid mouse Canvas tool:', value);
  return 'select';
}

/**
 * Toolbar / tool-settings store.
 *
 * Persists explicit mouse, sketch, and input preferences separately from
 * Space-scoped placement/Lasso intent. Gesture navigation never edits
 * the saved mouse preference.
 */
export const useToolStore = create<ToolState>()(
  persistApplicationPreferences(
    (set, get) => ({
      pendingNodeType: null,
      explicitLassoActive: false,
      toolIntent: 0,
      ...DEFAULT_TOOL_PREFERENCES,
      chooseCanvasTool: (tool, isNotMouse) =>
        set((state) => ({
          ...(!isNotMouse ? { mouseToolPreference: tool } : {}),
          pendingNodeType: null,
          explicitLassoActive: tool === 'lasso',
          toolIntent: state.toolIntent + 1,
        })),
      setPendingNodeType: (type) =>
        set((state) => ({
          pendingNodeType: type,
          explicitLassoActive: false,
          toolIntent: state.toolIntent + 1,
        })),
      togglePendingNodeType: (type) =>
        set((state) => ({
          pendingNodeType: state.pendingNodeType === type ? null : type,
          explicitLassoActive: false,
          toolIntent: state.toolIntent + 1,
        })),
      finishPendingNodeType: (intent) => {
        if (get().toolIntent !== intent) return false;
        set({ pendingNodeType: null });
        return true;
      },
      setSketchDraft: (patch) =>
        set((state) => ({ sketchDraft: { ...state.sketchDraft, ...patch } })),
      setInputModePreference: (inputModePreference) =>
        set({ inputModePreference }),
      observePen: () => {
        if (!get().penObserved) set({ penObserved: true });
      },
      selectSketchColorPreset: (index) =>
        set((state) => {
          const color = state.colorPresets[index];
          if (color === undefined) return state;
          return {
            activeColorPreset: index,
            sketchDraft: { ...state.sketchDraft, strokeColor: color },
          };
        }),
      updateSketchColorPreset: (index, color) =>
        set((state) => {
          const presets = [...state.colorPresets] as SketchColorPresets;
          if (presets[index] === undefined) return state;
          presets[index] = color;
          return {
            colorPresets: presets,
            activeColorPreset: index,
            sketchDraft: { ...state.sketchDraft, strokeColor: color },
          };
        }),
      selectSketchSizePreset: (kind, index) =>
        set((state) => {
          const presets =
            kind === 'stroke'
              ? state.strokeSizePresets
              : state.eraserSizePresets;
          const value = presets[index];
          if (value === undefined) return state;
          return kind === 'stroke'
            ? {
                activeStrokeSizePreset: index,
                sketchDraft: { ...state.sketchDraft, strokeSize: value },
              }
            : {
                activeEraserSizePreset: index,
                sketchDraft: { ...state.sketchDraft, eraserSize: value },
              };
        }),
      updateSketchSizePreset: (kind, index, value) =>
        set((state) => {
          const key =
            kind === 'stroke' ? 'strokeSizePresets' : 'eraserSizePresets';
          const presets = [...state[key]] as SketchSizePresets;
          if (presets[index] === undefined) return state;
          presets[index] = value;
          return kind === 'stroke'
            ? {
                strokeSizePresets: presets,
                activeStrokeSizePreset: index,
                sketchDraft: { ...state.sketchDraft, strokeSize: value },
              }
            : {
                eraserSizePresets: presets,
                activeEraserSizePreset: index,
                sketchDraft: { ...state.sketchDraft, eraserSize: value },
              };
        }),
      resetForCanvasSwitch: () =>
        set((state) => ({
          pendingNodeType: null,
          explicitLassoActive: false,
          toolIntent: state.toolIntent + 1,
        })),
    }),
    {
      name: 'huabu-sketch-tools',
      version: 4,
      merge: (persisted, current) => ({
        ...current,
        ...DEFAULT_TOOL_PREFERENCES,
        ...(persisted as Partial<ToolState> | undefined),
        mouseToolPreference: readMouseToolPreference(
          (persisted as Partial<ToolState> | undefined)?.mouseToolPreference,
        ),
      }),
      migrate: (persistedState, version) => {
        if (!persistedState) return persistedState as ToolState;
        const state = persistedState as Partial<ToolState>;
        if (version < 1) {
          const strokeColor = state.sketchDraft?.strokeColor ?? 'black';
          state.colorPresets = [strokeColor, 'red', 'blue'];
          state.activeColorPreset = 0;
        }
        if (version < 2) {
          const activeIndex = state.activeEraserSizePreset ?? 1;
          const eraserSize = state.sketchDraft?.eraserSize;
          if (
            eraserSize !== undefined &&
            state.eraserSizePresets?.[activeIndex]
          ) {
            state.eraserSizePresets = [...state.eraserSizePresets];
            state.eraserSizePresets[activeIndex] = eraserSize;
          }
        }
        return {
          ...state,
          mouseToolPreference: readMouseToolPreference(
            state.mouseToolPreference,
          ),
        } as ToolState;
      },
      partialize: (state) => ({
        sketchDraft: state.sketchDraft,
        colorPresets: state.colorPresets,
        strokeSizePresets: state.strokeSizePresets,
        eraserSizePresets: state.eraserSizePresets,
        activeColorPreset: state.activeColorPreset,
        activeStrokeSizePreset: state.activeStrokeSizePreset,
        activeEraserSizePreset: state.activeEraserSizePreset,
        inputModePreference: state.inputModePreference,
        penObserved: state.penObserved,
        mouseToolPreference: state.mouseToolPreference,
      }),
    },
  ),
);
