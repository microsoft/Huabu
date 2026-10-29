// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusMessage } from './StatusMessage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('StatusMessage', () => {
  it.each([
    ['interrupted', 'messages.generationInterrupted', 'text-fg-default'],
    ['error', 'messages.somethingWentWrong', 'text-danger-fg'],
  ] as const)(
    'preserves the %s fallback with readable text',
    (status, label, color) => {
      act(() => root.render(<StatusMessage status={status} />));
      const text = container.querySelector('span');
      expect(text?.textContent).toBe(label);
      expect(text?.classList.contains(color)).toBe(true);
      expect(text?.parentElement?.classList.contains('text-xs')).toBe(true);
      expect(container.querySelector('button')).toBeNull();
    },
  );

  it.each(['interrupted', 'error'] as const)(
    'wraps long %s details without shrinking the icon or retry action',
    (status) => {
      const onRetry = vi.fn();
      const detail = `Unable to read /workspace/${'nested-directory/'.repeat(30)}file.ts`;
      act(() =>
        root.render(
          <StatusMessage status={status} detail={detail} onRetry={onRetry} />,
        ),
      );
      const text = container.querySelector('span');
      const icon = container.querySelector('svg');
      const retry = container.querySelector('button');
      expect(text?.textContent).toBe(detail);
      expect(text?.classList.contains('wrap-anywhere')).toBe(true);
      expect(icon?.classList.contains('shrink-0')).toBe(true);
      expect(icon?.parentElement?.classList.contains('items-start')).toBe(true);
      expect(retry?.classList.contains('shrink-0')).toBe(true);
      expect(retry?.getAttribute('aria-label')).toBe('messages.retry');
      if (!retry) throw new Error('Missing retry action');
      act(() => retry.click());
      expect(onRetry).toHaveBeenCalledOnce();
    },
  );
});
