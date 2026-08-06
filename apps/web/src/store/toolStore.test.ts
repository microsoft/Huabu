// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import { resolveInputMode, useToolStore } from './toolStore';

describe('toolStore input preference', () => {
  beforeEach(() => {
    localStorage.clear();
    useToolStore.setState({
      inputModePreference: 'auto',
      penObserved: false,
    });
  });

  it('resolves explicit modes without hardware inference', () => {
    expect(resolveInputMode('mouse', true, true)).toBe('mouse');
    expect(resolveInputMode('pen', false, false)).toBe('pen');
    expect(resolveInputMode('finger', false, true)).toBe('finger');
  });

  it('resolves auto from observed pen and touch capability', () => {
    expect(resolveInputMode('auto', false, false)).toBe('mouse');
    expect(resolveInputMode('auto', true, false)).toBe('finger');
    expect(resolveInputMode('auto', true, true)).toBe('pen');
  });

  it('persists observed pen input without rewriting the preference', () => {
    useToolStore.getState().setInputModePreference('finger');
    useToolStore.getState().observePen();

    const state = useToolStore.getState();
    expect(state.penObserved).toBe(true);
    expect(state.inputModePreference).toBe('finger');

    const stored = JSON.parse(
      localStorage.getItem('huabu-sketch-tools') ?? '{}',
    ) as { state?: Record<string, unknown> };
    expect(stored.state?.penObserved).toBe(true);
    expect(stored.state?.inputModePreference).toBe('finger');
  });
});

describe('toolStore sketch size presets', () => {
  beforeEach(() => {
    localStorage.clear();
    useToolStore.setState({
      pendingNodeType: null,
      sketchDraft: {
        strokeColor: 'black',
        strokeSize: 8,
        eraserSize: 24,
        mode: 'draw',
      },
      colorPresets: ['black', 'red', 'blue'],
      strokeSizePresets: [4, 8, 16],
      eraserSizePresets: [12, 24, 40],
      activeColorPreset: 0,
      activeStrokeSizePreset: 1,
      activeEraserSizePreset: 1,
      inputModePreference: 'auto',
      penObserved: false,
    });
  });

  it('keeps the default eraser size aligned with the active preset', () => {
    const initialState = useToolStore.getInitialState();

    expect(initialState.sketchDraft.eraserSize).toBe(12);
    expect(initialState.activeEraserSizePreset).toBe(0);
    expect(initialState.sketchDraft.eraserSize).toBe(
      initialState.eraserSizePresets[initialState.activeEraserSizePreset],
    );
  });

  it('selects a preset and applies it to the active sketch draft', () => {
    useToolStore.getState().selectSketchColorPreset(2);
    useToolStore.getState().selectSketchSizePreset('stroke', 2);
    useToolStore.getState().selectSketchSizePreset('eraser', 0);

    const state = useToolStore.getState();
    expect(state.activeColorPreset).toBe(2);
    expect(state.sketchDraft.strokeColor).toBe('blue');
    expect(state.activeStrokeSizePreset).toBe(2);
    expect(state.sketchDraft.strokeSize).toBe(16);
    expect(state.activeEraserSizePreset).toBe(0);
    expect(state.sketchDraft.eraserSize).toBe(12);
  });

  it('updates only the edited preset and applies its new value', () => {
    useToolStore.getState().updateSketchColorPreset(1, 'green');
    useToolStore.getState().updateSketchSizePreset('stroke', 1, 11);

    const state = useToolStore.getState();
    expect(state.colorPresets).toEqual(['black', 'green', 'blue']);
    expect(state.activeColorPreset).toBe(1);
    expect(state.sketchDraft.strokeColor).toBe('green');
    expect(state.strokeSizePresets).toEqual([4, 11, 16]);
    expect(state.eraserSizePresets).toEqual([12, 24, 40]);
    expect(state.activeStrokeSizePreset).toBe(1);
    expect(state.sketchDraft.strokeSize).toBe(11);
  });

  it('persists sketch preferences without transient placement state', () => {
    useToolStore.getState().setPendingNodeType('note');
    useToolStore.getState().updateSketchSizePreset('eraser', 2, 44);

    const stored = JSON.parse(
      localStorage.getItem('huabu-sketch-tools') ?? '{}',
    ) as { state?: Record<string, unknown> };

    expect(stored.state?.eraserSizePresets).toEqual([12, 24, 44]);
    expect(stored.state?.colorPresets).toEqual(['black', 'red', 'blue']);
    expect(stored.state?.pendingNodeType).toBeUndefined();
  });
});
