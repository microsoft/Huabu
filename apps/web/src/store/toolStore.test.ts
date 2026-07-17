import { beforeEach, describe, expect, it } from 'vitest';

import { useToolStore } from './toolStore';

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

  it('aligns a persisted version 1 eraser preset with the draft value', async () => {
    localStorage.setItem(
      'sediment-sketch-tools',
      JSON.stringify({
        version: 1,
        state: {
          sketchDraft: {
            strokeColor: 'black',
            strokeSize: 8,
            eraserSize: 16,
            mode: 'draw',
          },
          eraserSizePresets: [12, 24, 40],
          activeEraserSizePreset: 1,
        },
      }),
    );

    await useToolStore.persist.rehydrate();

    const state = useToolStore.getState();
    expect(state.sketchDraft.eraserSize).toBe(16);
    expect(state.eraserSizePresets).toEqual([12, 16, 40]);
    expect(state.activeEraserSizePreset).toBe(1);
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
      localStorage.getItem('sediment-sketch-tools') ?? '{}',
    ) as { state?: Record<string, unknown> };

    expect(stored.state?.eraserSizePresets).toEqual([12, 24, 44]);
    expect(stored.state?.colorPresets).toEqual(['black', 'red', 'blue']);
    expect(stored.state?.pendingNodeType).toBeUndefined();
  });
});
