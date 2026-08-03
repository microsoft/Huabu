import { describe, expect, it } from 'vitest';

import {
  buildAcpSessionSelectors,
  type AcpSessionSelectorSource,
} from '../acp-session-selectors.js';

const source = (
  partial: Partial<AcpSessionSelectorSource>,
): AcpSessionSelectorSource => ({
  availableModes: [],
  currentModeId: null,
  availableModels: [],
  currentModelId: null,
  configOptions: [],
  selections: {},
  ...partial,
});

describe('buildAcpSessionSelectors', () => {
  it('returns nothing when the agent advertises no knobs', () => {
    expect(buildAcpSessionSelectors(source({}))).toEqual([]);
  });

  it('synthesises mode and model pills from the legacy lists', () => {
    const selectors = buildAcpSessionSelectors(
      source({
        availableModes: [{ id: 'plan', name: 'Plan' }],
        currentModeId: 'plan',
        availableModels: [
          { modelId: 'sonnet', name: 'Sonnet', description: 'Balanced' },
        ],
        currentModelId: 'sonnet',
      }),
    );

    expect(selectors).toEqual([
      {
        id: 'mode',
        category: 'mode',
        label: '',
        kind: 'select',
        options: [{ value: 'plan', label: 'Plan' }],
        currentValue: 'plan',
        channel: 'mode',
        source: 'agent',
      },
      {
        id: 'model',
        category: 'model',
        label: '',
        kind: 'select',
        options: [
          { value: 'sonnet', label: 'Sonnet', description: 'Balanced' },
        ],
        currentValue: 'sonnet',
        channel: 'model',
        source: 'agent',
      },
    ]);
  });

  it('hides the legacy pill when a config-option twin exists', () => {
    const selectors = buildAcpSessionSelectors(
      source({
        availableModels: [
          { modelId: 'gpt-5-low', name: 'GPT-5 (low)' },
          { modelId: 'gpt-5-high', name: 'GPT-5 (high)' },
        ],
        currentModelId: 'gpt-5-low',
        configOptions: [
          {
            id: 'base_model',
            category: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'gpt-5',
            options: [{ value: 'gpt-5', name: 'GPT-5' }],
          },
        ],
      }),
    );

    expect(selectors.map((s) => s.id)).toEqual(['base_model']);
    expect(selectors[0].channel).toBe('config-option');
  });

  it('detects the twin by id when the agent publishes no category', () => {
    const selectors = buildAcpSessionSelectors(
      source({
        availableModes: [{ id: 'plan', name: 'Plan' }],
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            currentValue: 'collab',
            options: [{ value: 'collab', name: 'Collaborative' }],
          },
        ],
      }),
    );

    expect(selectors.map((s) => s.id)).toEqual(['mode']);
  });

  it('prefers the per-thread selection over the agent-reported value', () => {
    const selectors = buildAcpSessionSelectors(
      source({
        configOptions: [
          {
            id: 'model',
            category: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'sonnet',
            options: [
              { value: 'sonnet', name: 'Sonnet' },
              { value: 'haiku', name: 'Haiku' },
            ],
          },
          {
            id: 'allow_all',
            category: 'permissions',
            name: 'Allow all',
            type: 'boolean',
            currentValue: false,
          },
        ],
        selections: { model: 'haiku', allow_all: true },
      }),
    );

    expect(selectors.map((s) => [s.id, s.currentValue, s.source])).toEqual([
      ['model', 'haiku', 'user'],
      ['allow_all', true, 'user'],
    ]);
  });

  it('ignores a selection the agent no longer offers', () => {
    const [selector] = buildAcpSessionSelectors(
      source({
        configOptions: [
          {
            id: 'model',
            category: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'sonnet',
            options: [{ value: 'sonnet', name: 'Sonnet' }],
          },
        ],
        selections: { model: 'retired-model' },
      }),
    );

    expect(selector.currentValue).toBe('sonnet');
    expect(selector.source).toBe('agent');
  });

  it('ignores a selection whose primitive type does not match the knob', () => {
    const [selector] = buildAcpSessionSelectors(
      source({
        configOptions: [
          {
            id: 'allow_all',
            name: 'Allow all',
            type: 'boolean',
            currentValue: false,
          },
        ],
        selections: { allow_all: 'on' },
      }),
    );

    expect(selector.currentValue).toBe(false);
    expect(selector.source).toBe('agent');
  });

  it('reads a boolean a fork serialised as a string', () => {
    // Every non-empty string is truthy, so `'false'` would otherwise
    // render the pill as on.
    const [selector] = buildAcpSessionSelectors(
      source({
        configOptions: [
          {
            id: 'allow_all',
            name: 'Allow all',
            type: 'boolean',
            currentValue: 'false',
          },
        ],
      }),
    );

    expect(selector.currentValue).toBe(false);
  });

  it('keeps reading an unlisted on-word as on', () => {
    // Only the explicit off spellings flip; anything else keeps the raw
    // string's truthiness, so a fork emitting `'on'` does not regress.
    const [selector] = buildAcpSessionSelectors(
      source({
        configOptions: [
          {
            id: 'allow_all',
            name: 'Allow all',
            type: 'boolean',
            currentValue: 'on',
          },
        ],
      }),
    );

    expect(selector.currentValue).toBe(true);
  });

  it('applies a per-thread selection to a legacy channel', () => {
    const [selector] = buildAcpSessionSelectors(
      source({
        availableModels: [
          { modelId: 'sonnet', name: 'Sonnet' },
          { modelId: 'opus', name: 'Opus' },
        ],
        currentModelId: 'sonnet',
        selections: { model: 'opus' },
      }),
    );

    expect(selector.currentValue).toBe('opus');
    expect(selector.channel).toBe('model');
    expect(selector.source).toBe('user');
  });

  it('flattens grouped options and marks the group head', () => {
    const [selector] = buildAcpSessionSelectors(
      source({
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'a',
            options: [
              {
                name: 'Anthropic',
                options: [
                  { value: 'a', name: 'Sonnet' },
                  { value: 'b', name: 'Opus' },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(selector.options).toEqual([
      { value: 'a', label: 'Sonnet', sectionLabel: 'Anthropic' },
      { value: 'b', label: 'Opus' },
    ]);
  });

  it('falls back to the first option when the agent reports no value yet', () => {
    const [selector] = buildAcpSessionSelectors(
      source({
        configOptions: [
          {
            id: 'thought_level',
            name: 'Reasoning',
            type: 'select',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      }),
    );

    expect(selector.currentValue).toBe('low');
  });

  it('drops options that carry no id and selects with nothing to pick', () => {
    const selectors = buildAcpSessionSelectors(
      source({
        configOptions: [
          { name: 'Nameless', type: 'select', options: [{ value: 'x' }] },
          { id: 'empty', name: 'Empty', type: 'select', options: [] },
        ],
      }),
    );

    expect(selectors).toEqual([]);
  });
});
