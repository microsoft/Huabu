// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import '@/i18n';

import { FileReferencePreview } from './FileReferencePreview';

import type * as DeviceFilesApi from '@/api/device-files';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock('@/api/device-files', async (original) => ({
  ...(await original<typeof DeviceFilesApi>()),
  readDeviceFile: mocks.read,
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('renders leading YAML frontmatter outside Milkdown so scalar metadata does not become a Setext heading while body rules still render', async () => {
  mocks.read.mockResolvedValue({
    path: '/doc.md',
    text: '---\ntitle: Architecture Spec\nauthor: Alice\n---\n\n# Overview\n\n---\n\n```yaml\nport: 8080\n```\n',
    encoding: 'utf-8',
    byteLength: 103,
    size: 103,
    contentVersion: 'b'.repeat(64),
  });

  await act(async () =>
    root.render(
      <FileReferencePreview
        id="doc-node"
        data={{
          fileReference: { agentletId: 'remote-device', path: '/doc.md' },
        }}
      />,
    ),
  );

  await vi.waitFor(
    () => {
      expect(host.querySelector('.ProseMirror h1')?.textContent).toBe(
        'Overview',
      );
    },
    { timeout: 5000 },
  );

  const frontmatterSection = host.querySelector('section');
  expect(frontmatterSection?.querySelector('pre')?.textContent).toBe(
    'title: Architecture Spec\nauthor: Alice',
  );

  const editor = host.querySelector('.ProseMirror');
  expect(editor?.querySelector('h2')).toBeNull();
  expect(editor?.querySelectorAll('hr')).toHaveLength(1);
  expect(editor?.textContent).toContain('port: 8080');
  expect(editor?.textContent).not.toContain('Architecture Spec');
});
