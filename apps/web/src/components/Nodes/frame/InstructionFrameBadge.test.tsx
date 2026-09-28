// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InstructionFrameBadge } from './InstructionFrameBadge.tsx';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('InstructionFrameBadge', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
  });

  it.each([
    ['prompt', 0, 'node.promptFrameBadgeGlobal', 'bg-info'],
    ['prompt', 2, 'node.promptFrameBadgeConnected:2', 'bg-info'],
    ['skill', 0, 'node.skillFrameBadge', 'bg-success'],
  ] as const)(
    'renders the %s semantic pill with %s direct Agents',
    (kind, directAgentCount, label, tone) => {
      container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      act(() =>
        root.render(
          <InstructionFrameBadge
            kind={kind}
            directAgentCount={directAgentCount}
            titleFontSize={36}
          />,
        ),
      );

      const badge = container.querySelector('span');
      expect(badge?.textContent).toBe(label);
      expect(badge?.classList.contains(tone)).toBe(true);
      expect(badge?.classList.contains('text-fg-inverse')).toBe(true);
      expect(badge?.classList.contains('rounded-full')).toBe(true);
      expect(badge?.classList.contains('pointer-events-auto')).toBe(true);
      expect(badge?.getAttribute('title')).toBe(
        kind === 'skill'
          ? 'node.skillFrameBadgeDescription'
          : directAgentCount > 0
            ? `node.promptFrameBadgeConnectedDescription:${directAgentCount}`
            : 'node.promptFrameBadgeGlobalDescription',
      );
      expect(badge?.style.fontSize).toBe('15px');
      expect(badge?.style.height).toBe('27px');
      expect(badge?.querySelector('svg')).toBeNull();

      act(() => root.unmount());
    },
  );
});
