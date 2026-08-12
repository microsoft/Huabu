// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OAuthDeviceCodePrompt } from './OAuthDeviceCodePrompt';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

function renderPrompt() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <OAuthDeviceCodePrompt
        userCode="ABCD-1234"
        verificationUri="https://github.com/login/device"
        onCancel={vi.fn()}
      />,
    );
  });
}

describe('OAuthDeviceCodePrompt', () => {
  it('keeps the device code visible without opening GitHub', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    renderPrompt();

    expect(container?.textContent).toContain('ABCD-1234');
    expect(open).not.toHaveBeenCalled();
  });

  it('opens GitHub only after explicit user action', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPrompt();
    const openButton = Array.from(
      container?.querySelectorAll('button') ?? [],
    ).find((button) => button.textContent?.includes('settings.openGitHub'));

    expect(openButton).toBeDefined();
    act(() => openButton?.click());

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      'https://github.com/login/device',
      '_blank',
      'noopener',
    );
  });
});
