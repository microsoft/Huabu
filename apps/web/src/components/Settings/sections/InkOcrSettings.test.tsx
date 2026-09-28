// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/_client';
import en from '@/i18n/resources/en/common.json';
import zh from '@/i18n/resources/zh-CN/common.json';

import { InkOcrSettings } from './InkOcrSettings';

import type { InkOcrConfig } from '@huabu/shared';

const { getInkOcrConfig, putInkOcrConfig, toast, t, readinessState } =
  vi.hoisted(() => ({
    getInkOcrConfig: vi.fn(),
    putInkOcrConfig: vi.fn(),
    toast: vi.fn(),
    t: vi.fn<(key: string) => string>(),
    readinessState: {
      readiness: { credentials: { writable: true } } as {
        credentials: { writable: boolean };
      } | null,
      loading: false,
      error: null as string | null,
      load: vi.fn(),
    },
  }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}));
vi.mock('@/api/inkOcr', () => ({ getInkOcrConfig, putInkOcrConfig }));
vi.mock('@/components/Common/Toast', () => ({ toast }));
vi.mock('@/store/deploymentReadinessStore', () => ({
  useDeploymentReadinessStore: (
    selector: (state: typeof readinessState) => unknown,
  ) => selector(readinessState),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const unconfigured: InkOcrConfig = {
  provider: 'azure-vision',
  endpoint: null,
  endpointSource: 'none',
  keySource: 'none',
  hasStoredKey: false,
  configured: false,
};
const stored = {
  provider: 'azure-vision',
  endpoint: 'https://saved.cognitiveservices.azure.com',
  endpointSource: 'stored',
  keySource: 'stored',
  hasStoredKey: true,
  configured: true,
} satisfies InkOcrConfig;
const environment: InkOcrConfig = {
  ...stored,
  endpoint: 'https://environment.cognitiveservices.azure.com',
  endpointSource: 'environment',
  keySource: 'environment',
  hasStoredKey: false,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  t.mockImplementation(
    (key) =>
      key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)[part],
          en,
        ) as string,
  );
  readinessState.readiness = { credentials: { writable: true } };
  readinessState.loading = false;
  readinessState.error = null;
  getInkOcrConfig.mockResolvedValue(unconfigured);
  putInkOcrConfig.mockResolvedValue(stored);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderSettings() {
  await act(async () => root.render(<InkOcrSettings />));
}

function button(label: string) {
  const match = Array.from(container.querySelectorAll('button')).find(
    (element) =>
      element.textContent === label ||
      element.getAttribute('aria-label') === label,
  );
  expect(match).toBeDefined();
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function endpointInput() {
  return container.querySelector('input[type="url"]') as HTMLInputElement;
}

function keyInput() {
  return container.querySelector('input[type="password"]') as HTMLInputElement;
}

function change(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function renderEditor() {
  await renderSettings();
  const action = container.querySelector('button');
  expect(action).not.toBeNull();
  await act(async () => action?.click());
}

describe('InkOcrSettings', () => {
  it('shows loading without editable controls until configuration arrives', async () => {
    let finish!: (config: InkOcrConfig) => void;
    getInkOcrConfig.mockReturnValueOnce(
      new Promise<InkOcrConfig>((resolve) => {
        finish = resolve;
      }),
    );
    await renderSettings();
    expect(container.textContent).toContain(en.settings.inkOcr.loading);
    expect(container.querySelector('input')).toBeNull();
    await act(async () => finish(unconfigured));
    expect(button(en.settings.setApiKey)).toBeDefined();
    expect(container.querySelector('input')).toBeNull();
  });

  it.each([unconfigured, environment])(
    'defaults to one row and a small key icon for $keySource credentials',
    async (config) => {
      getInkOcrConfig.mockResolvedValue(config);
      await renderSettings();
      expect(container.querySelector('section > div')?.children).toHaveLength(
        1,
      );
      expect(container.querySelectorAll('p')).toHaveLength(2);
      expect(container.textContent).toContain(en.settings.inkOcr.title);
      expect(container.textContent).toContain(en.settings.inkOcr.description);
      expect(container.querySelectorAll('button')).toHaveLength(1);
      expect(
        button(
          config.keySource === 'none'
            ? en.settings.setApiKey
            : en.settings.updateKey,
        ),
      ).toBeDefined();
      const icon = container.querySelector('svg.lucide-key');
      expect(icon?.getAttribute('width')).toBe('14');
      expect(icon?.getAttribute('height')).toBe('14');
      expect(icon?.getAttribute('aria-label')).toBe(
        config.configured
          ? en.settings.inkOcr.configured
          : en.settings.inkOcr.notConfigured,
      );
      expect(container.querySelector('svg.lucide-check')).toBeNull();
      expect(container.querySelector('input')).toBeNull();
      expect(container.textContent).not.toContain('VISION_');
    },
  );

  it('opens both labeled inputs immediately with only Save and Cancel', async () => {
    getInkOcrConfig.mockResolvedValue(environment);
    await renderEditor();
    expect(container.querySelectorAll('input')).toHaveLength(2);
    expect(endpointInput().labels?.[0]?.textContent).toBe('Endpoint');
    expect(keyInput().labels?.[0]?.textContent).toBe('API Key');
    expect(endpointInput().value).toBe(environment.endpoint);
    expect(keyInput().value).toBe('');
    expect(keyInput().placeholder).toBe('Azure Key');
    expect(keyInput().autocomplete).toBe('off');
    expect(container.querySelectorAll('p')).toHaveLength(2);
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(button(en.actions.save).disabled).toBe(true);
    expect(button(en.actions.cancel)).toBeDefined();
    expect(container.textContent).not.toContain('VISION_');
    expect(putInkOcrConfig).not.toHaveBeenCalled();
  });

  it('uses standard divided setting rows and control widths below the heading', async () => {
    await renderEditor();
    const card = container.querySelector('section > div');
    expect(card?.classList.contains('divide-y')).toBe(true);
    expect(card?.children).toHaveLength(4);
    expect(card?.children[0]?.textContent).toContain(en.settings.inkOcr.title);
    expect(card?.children[0]?.querySelector('input')).toBeNull();
    const labels = card?.querySelectorAll('label');
    expect(labels).toHaveLength(2);
    for (const label of labels ?? []) {
      expect(label.control?.id).toBe(label.htmlFor);
      const row = label.closest('.px-3');
      expect(row?.parentElement).toBe(card);
      expect(row?.classList.contains('py-2.5')).toBe(true);
      expect(row?.classList.contains('items-center')).toBe(true);
      expect(label.classList.contains('text-xs')).toBe(true);
      expect(label.classList.contains('font-medium')).toBe(true);
      expect(label.control?.closest('.w-72')?.parentElement).toBe(
        row?.lastElementChild,
      );
    }
    expect(card?.children[1]?.querySelector('input')).toBe(endpointInput());
    expect(card?.children[2]?.querySelector('input')).toBe(keyInput());
    expect(card?.children[3]?.contains(button(en.actions.save))).toBe(true);
    expect(
      button(en.actions.save).parentElement?.classList.contains('justify-end'),
    ).toBe(true);
  });

  it('uses the same conventional visible field labels in both locales', () => {
    for (const locale of [en, zh]) {
      expect(locale.settings.inkOcr.endpointLabel).toBe('Endpoint');
      expect(locale.settings.inkOcr.apiKeyLabel).toBe('API Key');
    }
  });

  it('cancels without mutation and clears unsaved secrets', async () => {
    await renderEditor();
    change(endpointInput(), stored.endpoint);
    change(keyInput(), 'unsaved-private-key');
    await click(en.actions.cancel);
    expect(container.querySelector('input')).toBeNull();
    expect(container.innerHTML).not.toContain('unsaved-private-key');
    expect(putInkOcrConfig).not.toHaveBeenCalled();
    await click(en.settings.setApiKey);
    expect(keyInput().value).toBe('');
    expect(endpointInput().value).toBe('');
    expect(getInkOcrConfig).toHaveBeenCalledOnce();
  });

  it('retries a failed load before allowing editing', async () => {
    getInkOcrConfig.mockRejectedValueOnce(new Error('unavailable'));
    await renderSettings();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      en.settings.inkOcr.loadFailed,
    );
    expect(container.querySelector('input')).toBeNull();
    await click(en.settings.inkOcr.retry);
    expect(getInkOcrConfig).toHaveBeenCalledTimes(2);
    await click(en.settings.setApiKey);
    expect(container.querySelectorAll('input')).toHaveLength(2);
  });

  it.each([stored, environment])(
    'saves only a changed endpoint and preserves a blank $keySource key',
    async (config) => {
      getInkOcrConfig.mockResolvedValue(config);
      await renderEditor();
      change(endpointInput(), 'https://new.cognitiveservices.azure.com');
      change(keyInput(), '   ');
      expect(putInkOcrConfig).not.toHaveBeenCalled();
      await click(en.actions.save);
      expect(putInkOcrConfig).toHaveBeenCalledExactlyOnceWith({
        endpoint: 'https://new.cognitiveservices.azure.com',
      });
      expect(container.querySelector('input')).toBeNull();
      expect(toast).toHaveBeenCalledWith(en.settings.inkOcr.saved, {
        tone: 'success',
      });
    },
  );

  it('clears an endpoint with null without removing the key', async () => {
    getInkOcrConfig.mockResolvedValue(stored);
    putInkOcrConfig.mockResolvedValue(environment);
    await renderEditor();
    change(endpointInput(), '');
    await click(en.actions.save);
    expect(putInkOcrConfig).toHaveBeenCalledExactlyOnceWith({
      endpoint: null,
    });
    await click(en.settings.updateKey);
    expect(endpointInput().value).toBe(environment.endpoint);
  });

  it('saves only a new key and never refills a saved secret', async () => {
    getInkOcrConfig.mockResolvedValue(stored);
    await renderEditor();
    change(keyInput(), ' new-private-key ');
    await click(en.actions.save);
    expect(putInkOcrConfig).toHaveBeenCalledExactlyOnceWith({
      apiKey: 'new-private-key',
    });
    expect(container.querySelector('input')).toBeNull();
    expect(container.innerHTML).not.toContain('new-private-key');
    await click(en.settings.updateKey);
    expect(keyInput().value).toBe('');
  });

  it('submits both changed fields together', async () => {
    await renderEditor();
    change(endpointInput(), stored.endpoint);
    change(keyInput(), 'private-key');
    await click(en.actions.save);
    expect(putInkOcrConfig).toHaveBeenCalledExactlyOnceWith({
      endpoint: stored.endpoint,
      apiKey: 'private-key',
    });
    expect(container.querySelector('input')).toBeNull();
  });

  it('removes a stored override only through its explicit icon action', async () => {
    getInkOcrConfig.mockResolvedValue(stored);
    putInkOcrConfig.mockResolvedValue(environment);
    await renderEditor();
    expect(button(en.actions.save).disabled).toBe(true);
    await click(en.settings.inkOcr.removeStoredKey);
    expect(putInkOcrConfig).toHaveBeenCalledExactlyOnceWith({ apiKey: null });
    expect(container.querySelector('input')).toBeNull();
    await click(en.settings.updateKey);
    expect(
      container.querySelector(
        `[aria-label="${en.settings.inkOcr.removeStoredKey}"]`,
      ),
    ).toBeNull();
    expect(button(en.actions.save).disabled).toBe(true);
  });

  it('reconciles failed acknowledgements without resetting drafts and safely retries', async () => {
    getInkOcrConfig
      .mockResolvedValueOnce(unconfigured)
      .mockResolvedValueOnce(stored);
    putInkOcrConfig.mockRejectedValueOnce(new Error('acknowledgement failed'));
    await renderEditor();
    change(endpointInput(), stored.endpoint);
    change(keyInput(), 'retry-key');
    await click(en.actions.save);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      en.settings.inkOcr.saveFailed,
    );
    expect(endpointInput().value).toBe(stored.endpoint);
    expect(keyInput().value).toBe('retry-key');
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      en.settings.inkOcr.saveFailed,
      { tone: 'danger' },
    );
    expect(getInkOcrConfig).toHaveBeenCalledTimes(2);
    await click(en.actions.save);
    expect(putInkOcrConfig).toHaveBeenLastCalledWith({ apiKey: 'retry-key' });
    expect(container.querySelector('input')).toBeNull();
  });

  it('keeps failure visible and drafts retryable if status refresh also fails', async () => {
    getInkOcrConfig
      .mockResolvedValueOnce(unconfigured)
      .mockRejectedValueOnce(new Error('refresh failed'));
    putInkOcrConfig.mockRejectedValueOnce(new Error('save failed'));
    await renderEditor();
    change(endpointInput(), stored.endpoint);
    await click(en.actions.save);
    expect(endpointInput().value).toBe(stored.endpoint);
    expect(button(en.actions.save).disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows safe actionable validation errors without exposing response details', async () => {
    const guidance =
      'Endpoint must be an HTTPS resource-root URL on a public Azure host: <resource>.cognitiveservices.azure.com or <region>.api.cognitive.microsoft.com.';
    putInkOcrConfig.mockRejectedValueOnce(
      new ApiError(
        400,
        {
          code: 'validation_failed',
          message: guidance,
          details: { apiKey: 'secret-response-detail' },
        },
        'fallback',
      ),
    );
    await renderEditor();
    change(endpointInput(), 'https://invalid.example.com');
    change(keyInput(), 'draft-private-key');
    await click(en.actions.save);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      guidance,
    );
    expect(toast).toHaveBeenCalledExactlyOnceWith(guidance, {
      tone: 'danger',
    });
    expect(container.textContent).not.toContain('secret-response-detail');
    expect(endpointInput().value).toBe('https://invalid.example.com');
    expect(keyInput().value).toBe('draft-private-key');
    change(endpointInput(), stored.endpoint);
    await click(en.actions.save);
    expect(putInkOcrConfig).toHaveBeenLastCalledWith({
      endpoint: stored.endpoint,
      apiKey: 'draft-private-key',
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
  });

  it.each([
    new ApiError(
      500,
      { code: 'validation_failed', message: 'private-key-in-server-error' },
      'fallback',
    ),
    new ApiError(
      400,
      { code: 'other_error', message: 'private-key-in-other-error' },
      'fallback',
    ),
    new TypeError('private-key-in-network-error'),
  ])(
    'uses a generic localized failure instead of echoing $message',
    async (error) => {
      putInkOcrConfig.mockRejectedValueOnce(error);
      await renderEditor();
      change(endpointInput(), stored.endpoint);
      await click(en.actions.save);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        en.settings.inkOcr.saveFailed,
      );
      expect(toast).toHaveBeenCalledExactlyOnceWith(
        en.settings.inkOcr.saveFailed,
        { tone: 'danger' },
      );
      expect(container.textContent).not.toContain(error.message);
    },
  );

  it.each(['read-only', 'unknown', 'loading', 'error'] as const)(
    'allows viewing but blocks all OCR edits when readiness is %s',
    async (state) => {
      getInkOcrConfig.mockResolvedValue(stored);
      if (state === 'read-only') {
        readinessState.readiness = { credentials: { writable: false } };
      } else if (state === 'unknown') {
        readinessState.readiness = null;
      } else if (state === 'loading') {
        readinessState.loading = true;
      } else {
        readinessState.readiness = null;
        readinessState.error = 'unavailable';
      }
      await renderEditor();
      expect(keyInput().disabled).toBe(true);
      expect(button(en.settings.inkOcr.removeStoredKey).disabled).toBe(true);
      expect(endpointInput().disabled).toBe(true);
      expect(endpointInput().value).toBe(stored.endpoint);
      expect(button(en.actions.cancel).disabled).toBe(false);
      expect(container.textContent).toContain(
        state === 'read-only'
          ? en.settings.inkOcr.readOnly
          : en.settings.inkOcr.readinessPending,
      );
      if (state === 'error') {
        await click(en.settings.inkOcr.retryReadiness);
        expect(readinessState.load).toHaveBeenCalledOnce();
      }
      change(endpointInput(), 'https://other.cognitiveservices.azure.com');
      expect(button(en.actions.save).disabled).toBe(true);
      await click(en.actions.save);
      await click(en.settings.inkOcr.removeStoredKey);
      await act(async () => {
        container
          .querySelector('form')
          ?.dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
          );
      });
      expect(putInkOcrConfig).not.toHaveBeenCalled();
    },
  );

  it.each(['endpoint', 'key', 'combined'])(
    'guards %s drafts if readiness becomes read-only while editing',
    async (field) => {
      getInkOcrConfig.mockResolvedValue(stored);
      await renderEditor();
      if (field !== 'key') {
        change(endpointInput(), 'https://other.cognitiveservices.azure.com');
      }
      if (field !== 'endpoint') change(keyInput(), 'private-key');
      readinessState.readiness = { credentials: { writable: false } };
      await renderSettings();
      expect(endpointInput().disabled).toBe(true);
      expect(keyInput().disabled).toBe(true);
      expect(button(en.settings.inkOcr.removeStoredKey).disabled).toBe(true);
      expect(button(en.actions.save).disabled).toBe(true);
      await act(async () => {
        container
          .querySelector('form')
          ?.dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
          );
      });
      expect(putInkOcrConfig).not.toHaveBeenCalled();
      readinessState.readiness = { credentials: { writable: true } };
      await renderSettings();
      expect(endpointInput().disabled).toBe(false);
      expect(keyInput().disabled).toBe(false);
      expect(button(en.actions.save).disabled).toBe(false);
      await click(en.actions.save);
      expect(putInkOcrConfig).toHaveBeenCalledExactlyOnceWith({
        ...(field !== 'key'
          ? { endpoint: 'https://other.cognitiveservices.azure.com' }
          : {}),
        ...(field !== 'endpoint' ? { apiKey: 'private-key' } : {}),
      });
    },
  );

  it('disables edits, duplicate submissions and cancellation while saving', async () => {
    let finish!: (config: InkOcrConfig) => void;
    putInkOcrConfig.mockReturnValueOnce(
      new Promise<InkOcrConfig>((resolve) => {
        finish = resolve;
      }),
    );
    await renderEditor();
    change(endpointInput(), stored.endpoint);
    await click(en.actions.save);
    expect(endpointInput().disabled).toBe(true);
    expect(keyInput().disabled).toBe(true);
    expect(button(en.actions.cancel).disabled).toBe(true);
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      endpointInput().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(putInkOcrConfig).toHaveBeenCalledOnce();
    expect(endpointInput()).not.toBeNull();
    await act(async () => finish(stored));
    expect(container.querySelector('input')).toBeNull();
  });
});
