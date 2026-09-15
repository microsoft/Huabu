// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasActions } from './useCanvasActions';
import { ToastContainer } from '../components/Common/Toast';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./useInputMode', () => ({ useEffectiveInputMode: () => 'mouse' }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
function ImportControl() {
  const { onFileChange, isImporting } = useCanvasActions();
  return (
    <>
      <input
        type="file"
        onChange={(e) => void onFileChange(e)}
        disabled={isImporting}
      />
      <ToastContainer />
    </>
  );
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    document
      .querySelectorAll<HTMLButtonElement>('[aria-label="actions.dismiss"]')
      .forEach((button) => button.click());
  });
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function selectArchive() {
  const input = container.querySelector('input');
  if (!input) throw new Error('Import input was not rendered');
  Object.defineProperty(input, 'files', {
    value: [new File(['zip'], 'space.huabu.zip')],
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return input;
}
async function renderImport() {
  const router = createMemoryRouter(
    [
      { path: '/spaces', element: <ImportControl /> },
      { path: '/canvas/:id', element: <div>Imported Space</div> },
    ],
    { initialEntries: ['/spaces'] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}
describe('Space import feedback', () => {
  it('shows a dismissible storage refusal, stays in the app, and allows retry', async () => {
    const fetch = vi.fn();
    fetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            code: 'STORAGE_CAPABILITY_UNAVAILABLE',
            message: 'Technical storage detail',
          }),
          { status: 400 },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const router = await renderImport();
    const input = await selectArchive();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'canvasList.importUnavailable',
    );
    expect(
      document.querySelector('[aria-label="actions.dismiss"]'),
    ).not.toBeNull();
    expect(router.state.location.pathname).toBe('/spaces');
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('');
    await selectArchive();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('shows other server failures instead of swallowing them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Invalid archive' }), {
          status: 400,
        }),
      ),
    );
    await renderImport();
    await selectArchive();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Invalid archive',
    );
  });
  it('opens a successfully imported Disk Space', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ canvasId: 'imported-space' }), {
          status: 200,
        }),
      ),
    );
    const router = await renderImport();
    await selectArchive();
    expect(router.state.location.pathname).toBe('/canvas/imported-space');
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});
