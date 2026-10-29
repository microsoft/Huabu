// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createInstance, type i18n } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/resources/en/common.json';
import zh from '@/i18n/resources/zh-CN/common.json';

import { ServicesSettings } from './ServicesSettings';

import type { ServiceConfig } from '@huabu/shared';

const mocks = vi.hoisted(() => ({
  getServices: vi.fn(),
  getService: vi.fn(),
  putService: vi.fn(),
  toast: vi.fn(),
  writable: true,
  readiness: true,
  loading: false,
  error: false,
}));

vi.mock('@/api/services', () => ({
  getServices: mocks.getServices,
  getService: mocks.getService,
  putService: mocks.putService,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: mocks.toast }));

vi.mock('@/store/deploymentReadinessStore', () => ({
  useDeploymentReadinessStore: (
    selector: (state: {
      readiness: { credentials: { writable: boolean } } | null;
      loading: boolean;
      error: string | null;
    }) => unknown,
  ) =>
    selector({
      readiness: mocks.readiness
        ? { credentials: { writable: mocks.writable } }
        : null,
      loading: mocks.loading,
      error: mocks.error ? 'Readiness unavailable' : null,
    }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ids = [
  'image-gen',
  'web-search',
  'youtube-transcripts',
  'ink-ocr',
] as const;

function config(id: string): ServiceConfig {
  return {
    manifest: {
      schema: 'huabu-service/v1',
      id,
      version: '1.0.0',
      name: id,
      description: `${id} description`,
      storage: { namespace: `integration.${id}` },
      package: { files: [] },
      configuration: [
        {
          id: 'apiKey',
          label: 'API key',
          type: 'secret',
          required: true,
        },
      ],
    },
    values: { apiKey: null },
    configuredFields: [],
    configured: false,
  };
}

let root: Root;
let container: HTMLDivElement;
let translations: i18n;

beforeEach(async () => {
  mocks.writable = true;
  mocks.readiness = true;
  mocks.loading = false;
  mocks.error = false;
  translations = createInstance();
  await translations.init({
    lng: 'zh-CN',
    fallbackLng: 'en',
    resources: { en: { translation: en }, 'zh-CN': { translation: zh } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getServices.mockResolvedValue({
    services: ids.map((id) => ({
      id,
      version: '1.0.0',
      name: id,
      description: id,
      configured: false,
      availableToExternalAgent: false,
    })),
  });
  mocks.getService.mockImplementation(async (id: (typeof ids)[number]) =>
    config(id),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      <I18nextProvider i18n={translations}>
        <ServicesSettings />
      </I18nextProvider>,
    ),
  );
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (element) =>
      element.textContent === label ||
      element.getAttribute('aria-label') === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

async function editInput(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  );
  if (!input) throw new Error(`Missing input: ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

async function blurInput(input: HTMLInputElement) {
  await act(async () =>
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
  );
}

function configuredOcr(): ServiceConfig {
  const initial = config('ink-ocr');
  initial.manifest.storage.namespace = 'integration.azureVisionInkOcr';
  initial.manifest.configuration.unshift({
    id: 'endpoint',
    type: 'url',
    label: 'Endpoint',
    required: true,
  });
  initial.values.endpoint = 'https://old.cognitiveservices.azure.com';
  initial.configuredFields = ['endpoint', 'apiKey'];
  initial.configured = true;
  return initial;
}

function useOcr(initial = configuredOcr()) {
  mocks.getServices.mockResolvedValue({ services: [{ id: 'ink-ocr' }] });
  mocks.getService.mockResolvedValue(initial);
  mocks.putService.mockImplementation(
    async (_id: string, { values }: { values: ServiceConfig['values'] }) => {
      initial = {
        ...initial,
        values: { ...initial.values, ...values, apiKey: null },
        configuredFields:
          values.apiKey === null ? ['endpoint'] : ['endpoint', 'apiKey'],
        configured: values.apiKey !== null,
      };
      return initial;
    },
  );
}

describe('ServicesSettings', () => {
  it.each(['zh-CN', 'en'])(
    'localizes bundled services and shows setup hints only while collapsed in %s',
    async (language) => {
      await translations.changeLanguage(language);
      await render();

      expect(mocks.getService).toHaveBeenCalledTimes(4);
      for (const id of ids) {
        expect(container.textContent).toContain(
          translations.t(`settings.serviceContent.${id}.name`),
        );
        expect(container.textContent).toContain(
          translations.t(`settings.serviceContent.${id}.description`),
        );
      }
      const pendingSetup = translations.t('settings.serviceUi.pendingSetup');
      const setupHints = () =>
        [...container.querySelectorAll('span')].filter(
          (element) => element.textContent === pendingSetup,
        );
      expect(setupHints()).toHaveLength(4);
      const configureSearch = translations.t(
        'settings.serviceUi.configureService',
        {
          name: translations.t('settings.serviceContent.web-search.name'),
        },
      );
      await click(configureSearch);
      expect(setupHints()).toHaveLength(3);
      await click(configureSearch);
      expect(setupHints()).toHaveLength(4);
      expect(container.textContent).not.toContain('preprocessing');
    },
  );

  it('omits configured status text and localizes secret controls', async () => {
    const configured = {
      ...config('web-search'),
      configured: true,
      configuredFields: ['apiKey'],
    };
    mocks.getService.mockImplementation(async (id: string) =>
      id === 'web-search' ? configured : config(id),
    );
    await render();
    expect(container.querySelector('.text-success-fg')).toBeNull();
    expect(container.textContent).not.toContain('已配置');
    expect(container.textContent).not.toContain('未验证');
    await click('配置网页搜索（Tavily）');
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('更新密钥');
    expect(
      container.querySelector('button[aria-label="移除API 密钥"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('撤销修改');
    await click('更新密钥');
    expect(container.querySelector('input')?.value).toBe('');
    expect(container.textContent).toContain('删除密钥');
  });

  it('localizes fields and options and saves selections immediately without a footer', async () => {
    const initial = config('image-gen');
    initial.manifest.configuration.push({
      id: 'quality',
      label: 'Image quality',
      type: 'enum',
      required: true,
      options: [
        { value: 'low', label: 'low' },
        { value: 'high', label: 'high' },
      ],
    });
    initial.values.quality = 'low';
    initial.configured = true;
    initial.configuredFields = ['apiKey', 'quality'];
    mocks.getService.mockImplementation(async (id: string) =>
      id === 'image-gen' ? initial : config(id),
    );
    mocks.putService.mockResolvedValue({
      ...initial,
      values: { ...initial.values, quality: 'high' },
    });
    await render();
    await click('配置图片生成（Azure OpenAI）');
    const select = container.querySelector<HTMLButtonElement>(
      '[aria-label="图片质量"]',
    );
    expect(select?.textContent).toBe('低');
    await click('低');
    const option = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === '高',
    );
    await act(async () => option?.click());
    expect(select?.textContent).toBe('高');
    expect(container.textContent).not.toContain('撤销修改');
    expect(container.textContent).not.toContain('保存');
    expect(mocks.putService).toHaveBeenCalledWith('image-gen', {
      values: { quality: 'high' },
    });
  });

  it('preserves manifest text for unknown services and fields', async () => {
    mocks.getServices.mockResolvedValue({
      services: [{ id: 'custom-service' }],
    });
    mocks.getService.mockResolvedValue(config('custom-service'));
    await render();
    expect(container.textContent).toContain('custom-service description');
    await click('配置custom-service');
    await click('设置 API 密钥');
    expect(container.querySelector('input')?.getAttribute('aria-label')).toBe(
      'API key',
    );
    expect(container.textContent).not.toContain('settings.serviceContent');
  });

  it('localizes loading and fallback errors', async () => {
    mocks.getServices.mockReturnValue(new Promise(() => {}));
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      '正在加载服务…',
    );
    act(() => root.unmount());
    root = createRoot(container);
    mocks.getServices.mockRejectedValue('unavailable');
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      '加载服务失败，请重试。',
    );
  });

  it('keeps a failed draft and shows a concise save error', async () => {
    mocks.putService.mockRejectedValue('failed');
    await render();
    await click('配置网页搜索（Tavily）');
    await click('设置 API 密钥');
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="API 密钥"]',
    );
    if (!input) throw new Error('Missing API key field');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'test-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('保存');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      '保存失败，请重试。',
    );
    expect(input.value).toBe('test-key');
  });

  it('commits ordinary fields on blur or Enter, rejects invalid URLs, and skips unchanged values', async () => {
    useOcr();
    await render();
    await click('配置手写识别（Azure AI Vision）');
    const input = await editInput(
      '服务地址',
      'https://new.cognitiveservices.azure.com',
    );
    expect(mocks.putService).not.toHaveBeenCalled();
    await blurInput(input);
    expect(mocks.putService).toHaveBeenCalledExactlyOnceWith('ink-ocr', {
      values: { endpoint: 'https://new.cognitiveservices.azure.com' },
    });
    await blurInput(input);
    expect(mocks.putService).toHaveBeenCalledOnce();
    await editInput('服务地址', 'http://insecure.example');
    await blurInput(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'HTTPS',
    );
    expect(mocks.putService).toHaveBeenCalledOnce();
    await editInput('服务地址', 'https://third.cognitiveservices.azure.com');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(mocks.putService).toHaveBeenCalledTimes(2);
  });

  it('stages first-time required settings and submits them together with an explicitly confirmed key', async () => {
    const initial = configuredOcr();
    initial.values.endpoint = '';
    initial.configuredFields = [];
    initial.configured = false;
    useOcr(initial);
    await render();
    await click('配置手写识别（Azure AI Vision）');
    await click('设置 API 密钥');
    await editInput('API 密钥', 'new-key');
    await click('保存');
    expect(mocks.putService).not.toHaveBeenCalled();
    expect(container.textContent).toContain('请先填写完整的必填设置');
    const endpoint = await editInput(
      '服务地址',
      'https://new.cognitiveservices.azure.com',
    );
    await blurInput(endpoint);
    expect(mocks.putService).not.toHaveBeenCalled();
    expect(container.textContent).toContain('提交 API 密钥时将一起保存此修改');
    await click('保存');
    expect(mocks.putService).toHaveBeenCalledExactlyOnceWith('ink-ocr', {
      values: {
        apiKey: 'new-key',
        endpoint: 'https://new.cognitiveservices.azure.com',
      },
    });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain('更新密钥');
  });

  it('retains failed endpoint drafts with inline retry and keeps them through key removal', async () => {
    useOcr();
    mocks.putService.mockRejectedValueOnce(new Error('endpoint save failed'));
    await render();
    await click('配置手写识别（Azure AI Vision）');
    const endpoint = await editInput(
      '服务地址',
      'https://draft.cognitiveservices.azure.com',
    );
    await blurInput(endpoint);
    expect(endpoint.value).toBe('https://draft.cognitiveservices.azure.com');
    expect(container.textContent).toContain('endpoint save failed');
    await click('更新密钥');
    await click('删除密钥');
    expect(mocks.putService).toHaveBeenCalledOnce();
    await click('取消');
    expect(mocks.putService).toHaveBeenCalledOnce();
    await click('删除密钥');
    await click('删除');
    expect(mocks.putService).toHaveBeenLastCalledWith('ink-ocr', {
      values: { apiKey: null },
    });
    expect(endpoint.value).toBe('https://draft.cognitiveservices.azure.com');
    expect(container.textContent).toContain('endpoint save failed');
  });

  it('retries endpoint errors and preserves an unrelated credential draft on successful writes', async () => {
    useOcr();
    mocks.putService.mockRejectedValueOnce(new Error('endpoint save failed'));
    await render();
    await click('配置手写识别（Azure AI Vision）');
    await click('更新密钥');
    const key = await editInput('API 密钥', 'unsaved-key');
    const endpoint = await editInput(
      '服务地址',
      'https://new.cognitiveservices.azure.com',
    );
    await blurInput(endpoint);
    await click('重试保存');
    expect(mocks.putService).toHaveBeenCalledTimes(2);
    expect(key.value).toBe('unsaved-key');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click('配置手写识别（Azure AI Vision）');
    expect(key.closest('[hidden]')).not.toBeNull();
    await click('配置手写识别（Azure AI Vision）');
    expect(container.querySelector('input[type="password"]')).toBe(key);
    expect(key.value).toBe('unsaved-key');
  });

  it.each(['read-only', 'loading', 'failed', 'unknown'] as const)(
    'blocks credential and OCR writes when readiness is %s',
    async (state) => {
      useOcr();
      mocks.writable = state !== 'read-only';
      mocks.readiness = state !== 'unknown';
      mocks.loading = state === 'loading';
      mocks.error = state === 'failed';
      await render();
      await click('配置手写识别（Azure AI Vision）');
      expect(container.querySelector<HTMLInputElement>('input')?.disabled).toBe(
        true,
      );
      const keyButton = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === '更新密钥',
      );
      expect(keyButton?.disabled).toBe(true);
      expect(mocks.putService).not.toHaveBeenCalled();
    },
  );

  it('serializes writes to different fields and preserves edits made while another field is saving', async () => {
    const initial = configuredOcr();
    initial.manifest.configuration.push({
      id: 'model',
      label: 'Model',
      type: 'text',
      required: false,
    });
    initial.values.model = 'original';
    useOcr(initial);
    let finish: ((value: ServiceConfig) => void) | undefined;
    mocks.putService.mockImplementationOnce(
      () =>
        new Promise<ServiceConfig>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click('配置手写识别（Azure AI Vision）');
    const endpoint = await editInput(
      '服务地址',
      'https://new.cognitiveservices.azure.com',
    );
    await blurInput(endpoint);
    expect(mocks.putService).toHaveBeenCalledOnce();
    const model = await editInput('Model', 'next-model');
    await blurInput(model);
    expect(mocks.putService).toHaveBeenCalledOnce();
    expect(endpoint.disabled).toBe(true);
    expect(model.disabled).toBe(true);
    if (!finish) throw new Error('Missing first save');
    mocks.putService.mockResolvedValueOnce({
      ...initial,
      values: {
        ...initial.values,
        endpoint: 'https://new.cognitiveservices.azure.com',
        model: 'next-model',
      },
    });
    await act(async () =>
      finish?.({
        ...initial,
        values: {
          ...initial.values,
          endpoint: 'https://new.cognitiveservices.azure.com',
        },
      }),
    );
    expect(mocks.putService).toHaveBeenCalledTimes(2);
    expect(mocks.putService).toHaveBeenLastCalledWith('ink-ocr', {
      values: { model: 'next-model' },
    });
    expect(model.value).toBe('next-model');
    expect(endpoint.value).toBe('https://new.cognitiveservices.azure.com');
  });

  it('retains failed removal confirmation and allows retry without clearing other drafts', async () => {
    useOcr();
    mocks.putService.mockRejectedValueOnce(new Error('cannot remove key'));
    await render();
    await click('配置手写识别（Azure AI Vision）');
    await click('更新密钥');
    await click('删除密钥');
    await click('删除');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'cannot remove key',
    );
    expect(container.textContent).toContain('删除 Huabu 保存的密钥');
    await click('删除');
    expect(mocks.putService).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('删除 Huabu 保存的密钥');
  });
});
