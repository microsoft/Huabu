// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { SignInGate } from './SignInGate';

vi.mock('../../pages/WorkspaceLoadingScreen', () => ({
  WorkspaceLoadingScreen: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// A build whose API lives on another origin (VITE_API_BASE).
vi.mock('../../config/api', () => ({
  API_CONFIG: {
    BASE_URL: 'https://api.example.com',
    get API_URL() {
      return 'https://api.example.com/api';
    },
  },
}));

afterEach(() => vi.unstubAllGlobals());

it('refuses browser sign-in when the API is on another origin', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/authenticators')
        ? new Response(
            JSON.stringify({
              authenticators: [
                {
                  driver: 'auth0',
                  interactive: true,
                  issuer: 'https://tenant.example/',
                  authorizationUrl: 'https://tenant.example/authorize',
                  clientId: 'spa',
                },
              ],
            }),
            { status: 200 },
          )
        : new Response('{}', { status: 401 }),
    ),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SignInGate>
        <p>app</p>
      </SignInGate>,
    );
  });
  for (let i = 0; i < 5; i++) await act(async () => {});
  expect(container.textContent).toContain('auth.crossOriginUnsupported');
  expect(container.querySelectorAll('button')).toHaveLength(0);
  act(() => root.unmount());
  container.remove();
});
