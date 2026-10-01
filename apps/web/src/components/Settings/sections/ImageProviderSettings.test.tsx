// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadImageConfig = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/store/deploymentReadinessStore', () => ({
  useDeploymentReadinessStore: (selector: (state: object) => unknown) =>
    selector({ readiness: { credentials: { writable: true } } }),
}));
vi.mock('@/store/llmStore', () => ({
  useLLMStore: (selector: (state: object) => unknown) =>
    selector({
      imageConfig: null,
      loadImageConfig,
      imageError: null,
      imageSaving: false,
      updateImageConfig: vi.fn(),
    }),
}));

import { ImageProviderSettings } from './ImageProviderSettings';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('ImageProviderSettings', () => {
  it('starts collapsed and expands on demand', async () => {
    await act(async () => {
      root.render(<ImageProviderSettings />);
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    );
    expect(toggle?.getAttribute('aria-label')).toBe('settings.imageGeneration');
    expect(toggle?.closest('section')?.textContent).toContain(
      'settings.imageGeneration',
    );
    expect(toggle?.closest('section')?.querySelector('.ring-1')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="settings.endpoint"]'),
    ).toBeNull();

    await act(async () => {
      toggle?.click();
    });

    expect(
      container.querySelector('[aria-label="settings.endpoint"]'),
    ).not.toBeNull();
  });
});
