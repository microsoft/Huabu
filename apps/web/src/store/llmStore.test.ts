// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLLMStore } from './llmStore';
import { startOAuthLogin } from '../api/llm';

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
