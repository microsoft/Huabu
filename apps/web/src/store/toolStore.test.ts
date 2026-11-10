// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveInputMode, useToolStore } from './toolStore';

describe('toolStore input preference', () => {
  beforeEach(() => {
    localStorage.clear();
    useToolStore.setState(useToolStore.getInitialState(), true);
  });

  describe('mouse Canvas preference and tool intent', () => {
    it.each(['select', 'pan', 'lasso'] as const)(
      'restores explicit mouse %s without persisting placement or session state',
      async (tool) => {
        useToolStore.getState().chooseCanvasTool(tool, false);
        useToolStore.getState().setPendingNodeType('note');
        const saved = localStorage.getItem('huabu-sketch-tools');
        expect(saved).not.toBeNull();
        expect(JSON.parse(saved!).state).toMatchObject({
          mouseToolPreference: tool,
        });
        for (const key of [
          'pendingNodeType',
          'explicitLassoActive',
          'toolIntent',
        ]) {
          expect(JSON.parse(saved!).state).not.toHaveProperty(key);
        }
        useToolStore.getState().resetForCanvasSwitch();
        await useToolStore.persist.rehydrate();
        expect(useToolStore.getState()).toMatchObject({
          mouseToolPreference: tool,
          pendingNodeType: null,
          explicitLassoActive: false,
        });
      },
    );

    it('does not save touch/pen tools or overwrite the mouse preference on placement', () => {
      useToolStore.getState().chooseCanvasTool('pan', false);
      for (const tool of ['lasso', 'select', 'pan'] as const) {
        useToolStore.getState().chooseCanvasTool(tool, true);
        expect(useToolStore.getState().mouseToolPreference).toBe('pan');
      }
      useToolStore.getState().togglePendingNodeType('note');
      const intent = useToolStore.getState().toolIntent;
      expect(useToolStore.getState().finishPendingNodeType(intent)).toBe(true);
      expect(useToolStore.getState().mouseToolPreference).toBe('pan');
    });

    it('rejects stale completion after same-type rearming, explicit choice, and Space reset', () => {
      useToolStore.getState().setPendingNodeType('question');
      const old = useToolStore.getState().toolIntent;
      useToolStore.getState().setPendingNodeType('question');
      expect(useToolStore.getState().finishPendingNodeType(old)).toBe(false);
      expect(useToolStore.getState().pendingNodeType).toBe('question');
      const current = useToolStore.getState().toolIntent;
      useToolStore.getState().chooseCanvasTool('lasso', false);
      expect(useToolStore.getState().finishPendingNodeType(current)).toBe(
        false,
      );
      useToolStore.getState().resetForCanvasSwitch();
      expect(useToolStore.getState().toolIntent).toBeGreaterThan(current);
    });

    it.each([0, 1, 2, 3])(
      'migrates version %s without losing existing preferences',
      async (version) => {
        localStorage.setItem(
          'huabu-sketch-tools',
          JSON.stringify({
            version,
            state: {
              inputModePreference: 'pen',
              penObserved: true,
              sketchDraft: {
                strokeColor: 'green',
                strokeSize: 11,
                eraserSize: 27,
                mode: 'erase',
              },
              eraserSizePresets: [12, 24, 40],
              activeEraserSizePreset: 1,
            },
          }),
        );
        await useToolStore.persist.rehydrate();
        expect(useToolStore.getState()).toMatchObject({
          mouseToolPreference: 'select',
          inputModePreference: 'pen',
          penObserved: true,
          sketchDraft: {
            strokeColor: 'green',
            strokeSize: 11,
            eraserSize: 27,
            mode: 'erase',
          },
        });
        if (version < 1)
          expect(useToolStore.getState().colorPresets[0]).toBe('green');
        if (version < 2)
          expect(useToolStore.getState().eraserSizePresets[1]).toBe(27);
        expect(
          JSON.parse(localStorage.getItem('huabu-sketch-tools')!).version,
        ).toBe(4);
      },
    );

    it('diagnoses invalid tool values and resets deleted preferences without resetting a session', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        localStorage.setItem(
          'huabu-sketch-tools',
          JSON.stringify({
            version: 4,
            state: {
              mouseToolPreference: 'sketch',
              inputModePreference: 'finger',
            },
          }),
        );
        await useToolStore.persist.rehydrate();
        expect(log).toHaveBeenCalled();
        expect(useToolStore.getState().mouseToolPreference).toBe('select');
        expect(useToolStore.getState().inputModePreference).toBe('finger');
        useToolStore.getState().chooseCanvasTool('lasso', true);
        localStorage.removeItem('huabu-sketch-tools');
        await useToolStore.persist.rehydrate();
        expect(useToolStore.getState().explicitLassoActive).toBe(true);
        expect(localStorage.getItem('huabu-sketch-tools')).toBeNull();
      } finally {
        log.mockRestore();
      }
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

  it('resets deleted preferences without clearing transient tool state or echoing a write', async () => {
    useToolStore.getState().setPendingNodeType('note');
    useToolStore.getState().setInputModePreference('finger');
    localStorage.removeItem('huabu-sketch-tools');
    await useToolStore.persist.rehydrate();
    expect(useToolStore.getState().inputModePreference).toBe('auto');
    expect(useToolStore.getState().pendingNodeType).toBe('note');
    expect(localStorage.getItem('huabu-sketch-tools')).toBeNull();
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
