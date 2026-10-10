// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapabilitiesSettings } from './CapabilitiesSettings';

import type { CapabilityConfig } from '@huabu/shared';

const mocks = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  getCapability: vi.fn(),
}));

vi.mock('@/api/capabilities', () => ({
  getCapabilities: mocks.getCapabilities,
  getCapability: mocks.getCapability,
  putCapability: vi.fn(),
}));

vi.mock('@/store/deploymentReadinessStore', () => ({
  useDeploymentReadinessStore: (
    selector: (state: {
      readiness: { credentials: { writable: boolean } };
    }) => unknown,
  ) => selector({ readiness: { credentials: { writable: true } } }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ids = [
  'image-gen',
  'web-search',
  'youtube-transcripts',
  'ink-ocr',
] as const;

function config(id: (typeof ids)[number]): CapabilityConfig {
  return {
    manifest: {
      schema: 'huabu-capability/v1',
      id,
      version: '1.0.0',
      name: id,
      description: `${id} description`,
      storage: { namespace: `integration.${id}` },
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getCapabilities.mockResolvedValue({
    capabilities: ids.map((id) => ({
      id,
      version: '1.0.0',
      name: id,
      description: id,
      configured: false,
      availableToExternalAgent: false,
    })),
  });
  mocks.getCapability.mockImplementation(async (id: (typeof ids)[number]) =>
    config(id),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('CapabilitiesSettings', () => {
  it('renders every current Capability from server manifests', async () => {
    await act(async () => {
      root.render(<CapabilitiesSettings />);
    });

    expect(mocks.getCapability).toHaveBeenCalledTimes(4);
    for (const id of ids) {
      expect(container.textContent).toContain(id);
    }
    expect(container.textContent).toContain('Not configured');
  });
});
