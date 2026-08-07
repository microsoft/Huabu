// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersistedAgentIconPicker } from './PersistedAgentIconPicker';

import type { AgentIconValue } from '@/components/Common/AgentIcon';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./AgentIconPicker', () => ({
  AgentIconPicker: ({
    value,
    onChange,
  }: {
    value: AgentIconValue;
    onChange: (value: AgentIconValue) => void;
  }) => (
    <>
      <output>{`${value.shape}:${value.color}`}</output>
      <button
        type="button"
        onClick={() => onChange({ ...value, shape: 'diamond' })}
      >
        shape
      </button>
      <button
        type="button"
        onClick={() => onChange({ ...value, color: 'red' })}
      >
        color
      </button>
    </>
  ),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('PersistedAgentIconPicker', () => {
  it('optimistically composes changes and saves the latest combination', async () => {
    let finishFirstSave: (() => void) | undefined;
    const onSave = vi
      .fn<(value: AgentIconValue) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstSave = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <PersistedAgentIconPicker
          value={{ shape: 'circle', color: 'blue' }}
          alias="Reviewer"
          onSave={onSave}
        />,
      ),
    );

    const buttons = container.querySelectorAll('button');
    act(() => buttons[0].click());
    act(() => buttons[1].click());

    expect(container.querySelector('output')?.textContent).toBe('diamond:red');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenNthCalledWith(1, {
      shape: 'diamond',
      color: 'blue',
    });

    await act(async () => finishFirstSave?.());

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenNthCalledWith(2, {
      shape: 'diamond',
      color: 'red',
    });
  });

  it('rolls back the optimistic value when saving fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('save failed'));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <PersistedAgentIconPicker
          value={{ shape: 'circle', color: 'blue' }}
          alias="Reviewer"
          onSave={onSave}
        />,
      ),
    );

    const shapeButton = container.querySelector('button');
    await act(async () => shapeButton?.click());

    expect(container.querySelector('output')?.textContent).toBe('circle:blue');
  });
});
