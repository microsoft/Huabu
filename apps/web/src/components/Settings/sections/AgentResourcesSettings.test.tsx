// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentResourcesSettings } from './AgentResourcesSettings';

const api = vi.hoisted(() => ({
  listAcpResources: vi.fn(),
  scanAcpResources: vi.fn(),
  importAcpResource: vi.fn(),
  updateAcpResource: vi.fn(),
  scanAcpResourceRefresh: vi.fn(),
  refreshAcpResource: vi.fn(),
  deleteAcpResource: vi.fn(),
}));
const i18n = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock('@/api/acp', () => api);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18n.t }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

async function renderSettings() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AgentResourcesSettings />);
  });
}

describe('AgentResourcesSettings', () => {
  it('shows source and display names while keeping source content read-only', async () => {
    api.listAcpResources.mockResolvedValue({
      resources: [
        {
          schemaVersion: 2,
          id: 'slides',
          provider: 'machine-a',
          name: 'Slides',
          displayName: 'Company Slides',
          sourceContent: '# Slides\n\nBuild a deck.',
          userContent: 'Use the company theme.',
        },
      ],
    });

    await renderSettings();

    expect(container?.textContent).toContain('Company Slides');
    expect(container?.textContent).toContain('Slides · slides · machine-a');
    expect(container?.querySelector('pre')?.textContent).toContain(
      'Build a deck.',
    );
    expect(container?.querySelector('textarea')?.value).toBe(
      'Use the company theme.',
    );
  });

  it('starts with an explicit read-only scan before import', async () => {
    api.listAcpResources.mockResolvedValue({ resources: [] });
    api.scanAcpResources.mockResolvedValue({
      rootPath: '/skills',
      candidates: [
        {
          id: 'slides',
          name: 'Slides',
          sourcePath: '/skills/slides',
          sourceContent: '# Slides',
          sourceRevision: 'a'.repeat(64),
        },
      ],
      diagnostics: [],
    });

    await renderSettings();
    const pathInput = container?.querySelector('input');
    if (!pathInput) throw new Error('Path input not found');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(pathInput, '/skills');
      pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const scanButton = Array.from(
      container?.querySelectorAll('button') ?? [],
    ).find((button) => button.textContent?.includes('settings.scanFolder'));
    await act(async () => {
      scanButton?.click();
    });

    expect(api.scanAcpResources).toHaveBeenCalledWith({
      rootPath: '/skills',
    });
    expect(api.importAcpResource).not.toHaveBeenCalled();
    expect(container?.textContent).toContain('/skills/slides');
  });
});
