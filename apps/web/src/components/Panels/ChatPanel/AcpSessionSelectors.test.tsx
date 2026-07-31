import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AcpSessionSelectors } from './AcpSessionSelectors';

import type { AcpSessionMetaSnapshot } from '@sediment/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../Common/Loading', () => ({
  Loading: () => null,
}));

vi.mock('../../Common/Popover', () => ({
  Popover: ({
    children,
    position,
    anchor,
  }: {
    children: React.ReactNode;
    position: { x: number; y: number };
    anchor: string;
  }) => (
    <div
      data-testid="popover"
      data-position-x={position.x}
      data-position-y={position.y}
      data-anchor={anchor}
    >
      {children}
    </div>
  ),
}));

vi.mock('../../Common/Select', () => ({
  Select: ({
    options,
    value,
    onChange,
    title,
  }: {
    options: Array<{ value: string; label: string }>;
    value: string;
    onChange: (value: string) => void;
    title?: string;
  }) => (
    <select
      aria-label={title}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const modeOptions = [
  { name: 'Agent', value: 'agent' },
  { name: 'Agent (full access)', value: 'agent-full-access' },
];

const meta: AcpSessionMetaSnapshot = {
  availableModes: [],
  currentModeId: null,
  availableModels: [],
  currentModelId: null,
  configOptions: [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'agent',
      options: modeOptions,
    },
  ],
  selections: {},
  sessionInfo: null,
  usage: null,
  updatedAt: 0,
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('AcpSessionSelectors full-access confirmation', () => {
  it('requires confirmation before selecting full access', () => {
    const onSelectConfigOption = vi.fn();
    container = document.createElement('div');
    container.dataset.chatInputSurface = '';
    container.getBoundingClientRect = () =>
      ({
        left: 104,
        top: 320,
        right: 728,
        bottom: 480,
        width: 624,
        height: 160,
        x: 104,
        y: 320,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AcpSessionSelectors
          meta={meta}
          onSelectMode={vi.fn()}
          onSelectModel={vi.fn()}
          onSelectConfigOption={onSelectConfigOption}
        />,
      );
    });

    const modeSelect = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Mode"]',
    );
    expect(modeSelect).not.toBeNull();
    act(() => {
      if (!modeSelect) return;
      modeSelect.value = 'agent-full-access';
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onSelectConfigOption).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('chat.fullAccessConfirmTitle');
    const popover = document.querySelector('[data-testid="popover"]');
    expect(popover?.getAttribute('data-position-x')).toBe('104');
    expect(popover?.getAttribute('data-position-y')).toBe('320');
    expect(popover?.getAttribute('data-anchor')).toBe('bottom-left');

    const confirmButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'chat.enableFullAccess');
    expect(confirmButton).not.toBeUndefined();
    act(() => confirmButton?.click());

    expect(onSelectConfigOption).toHaveBeenCalledWith(
      'mode',
      'agent-full-access',
    );
  });

  it('does not update full access when the warning is cancelled', () => {
    const onSelectConfigOption = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AcpSessionSelectors
          meta={meta}
          onSelectMode={vi.fn()}
          onSelectModel={vi.fn()}
          onSelectConfigOption={onSelectConfigOption}
        />,
      );
    });

    const modeSelect = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Mode"]',
    );
    act(() => {
      if (!modeSelect) return;
      modeSelect.value = 'agent-full-access';
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const cancelButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'actions.cancel');
    act(() => cancelButton?.click());

    expect(onSelectConfigOption).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      'chat.fullAccessConfirmTitle',
    );
  });

  it('updates ordinary mode values without confirmation', () => {
    const onSelectConfigOption = vi.fn();
    const readOnlyMeta = {
      ...meta,
      configOptions: [
        {
          ...meta.configOptions[0],
          currentValue: 'agent-full-access',
          options: [{ name: 'Read-only', value: 'read-only' }, ...modeOptions],
        },
      ],
    } as AcpSessionMetaSnapshot;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <AcpSessionSelectors
          meta={readOnlyMeta}
          onSelectMode={vi.fn()}
          onSelectModel={vi.fn()}
          onSelectConfigOption={onSelectConfigOption}
        />,
      );
    });

    const modeSelect = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Mode"]',
    );
    act(() => {
      if (!modeSelect) return;
      modeSelect.value = 'read-only';
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onSelectConfigOption).toHaveBeenCalledWith('mode', 'read-only');
    expect(document.body.textContent).not.toContain(
      'chat.fullAccessConfirmTitle',
    );
  });
});
