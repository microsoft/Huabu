// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLLMStore } from './llmStore';
import {
  startOAuthLogin,
  getLLMImageConfig,
  getLLMConfig,
  getLLMProviders,
  getLLMModels,
} from '../api/llm';

vi.mock('../api/llm', () => ({
  getLLMConfig: vi.fn(),
  getLLMImageConfig: vi.fn(),
  getLLMModels: vi.fn(),
  getLLMProviders: vi.fn(),
  getLLMUtilityConfig: vi.fn(),
  logoutOAuth: vi.fn(),
  pollOAuthLogin: vi.fn(),
  putLLMConfig: vi.fn(),
  putLLMImageConfig: vi.fn(),
  putLLMUtilityConfig: vi.fn(),
  startOAuthLogin: vi.fn(),
}));

describe('independent image configuration', () => {
  it('loads image settings without requesting Pi providers, credentials or models', async () => {
    vi.clearAllMocks();
    useLLMStore.setState({
      imageConfig: null,
      imageError: null,
      imageLoading: false,
    });
    vi.mocked(getLLMImageConfig).mockResolvedValue({
      provider: 'azure-openai',
      model: 'image-model',
      authenticated: true,
    });
    await useLLMStore.getState().loadImageConfig();
    expect(useLLMStore.getState().imageConfig?.model).toBe('image-model');
    expect(getLLMConfig).not.toHaveBeenCalled();
    expect(getLLMProviders).not.toHaveBeenCalled();
    expect(getLLMModels).not.toHaveBeenCalled();
  });

  it('surfaces image configuration read failures independently', async () => {
    vi.mocked(getLLMImageConfig).mockRejectedValueOnce(
      new Error('Image config unavailable'),
    );
    await useLLMStore.getState().loadImageConfig();
    expect(useLLMStore.getState().imageError).toBe('Image config unavailable');
  });
});

describe('LLM store OAuth login', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLLMStore.setState({
      config: null,
      oauthPending: false,
      oauthUserCode: null,
      oauthVerificationUri: null,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stores the device code without opening a browser window', async () => {
    vi.mocked(startOAuthLogin).mockResolvedValue({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    await useLLMStore.getState().startOAuth();

    expect(useLLMStore.getState()).toMatchObject({
      oauthPending: true,
      oauthUserCode: 'ABCD-1234',
      oauthVerificationUri: 'https://github.com/login/device',
    });
    expect(open).not.toHaveBeenCalled();
  });
});
