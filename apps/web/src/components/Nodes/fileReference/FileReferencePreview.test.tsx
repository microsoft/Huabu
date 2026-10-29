// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FileReferencePreview } from './FileReferencePreview';

import type { FileReadResult } from '@huabu/shared';
import type * as ReactI18next from 'react-i18next';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  viewer: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('@/api/device-files', () => ({ readDeviceFile: mocks.read }));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof ReactI18next>()),
  useTranslation: () => ({ t: mocks.t }),
}));
vi.mock('@/components/CodeMirror/RawMarkdownEditor', () => ({
  default: (props: {
    value: string;
    readOnly: boolean;
    plainText: boolean;
  }) => {
    mocks.viewer(props);
    return <pre>{props.value}</pre>;
  },
}));
const reference = { agentletId: 'remote-device', path: '/source.tex' };
const result = (text: string): FileReadResult => ({
  path: '/source.tex',
  text,
  encoding: 'utf-8',
  byteLength: text.length,
  size: 400_000,
  contentVersion: 'a'.repeat(64),
  nextCursor: 'next',
});
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
const button = (label: string) => {
  const found = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
};
async function open() {
  await act(async () =>
    root.render(
      <FileReferencePreview
        id="node-reference"
        data={{ fileReference: reference }}
      />,
    ),
  );
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector('pre')).not.toBeNull());
  });
}

it('reads source into a plain-text readonly viewer and never exceeds 256 KiB across UTF-8-sized chunks', async () => {
  mocks.read.mockImplementation(
    async (_device: string, args: { limitBytes?: number }) =>
      result('a'.repeat(Math.min(args.limitBytes ?? 65_536, 65_533))),
  );
  await open();
  expect(mocks.read.mock.calls[0]?.[0]).toBe('remote-device');
  for (let i = 0; i < 4; i++)
    await act(async () => button('files.readMore').click());
  expect(host.querySelector('pre')?.textContent?.length).toBe(262_144);
  expect(host.textContent).toContain('files.previewLimit');
  expect(mocks.read.mock.calls.at(-1)?.[1]).toMatchObject({ limitBytes: 12 });
  expect(mocks.viewer.mock.calls.at(-1)?.[0]).toMatchObject({
    readOnly: true,
    plainText: true,
  });
});

it('keeps stale text visibly errored until manual refresh and drops the continuation cursor', async () => {
  mocks.read
    .mockResolvedValueOnce(result('\\documentclass{article}'))
    .mockRejectedValueOnce(new Error('File changed'))
    .mockResolvedValueOnce({ ...result('replacement'), nextCursor: undefined });
  await open();
  await act(async () => button('files.readMore').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    'File changed',
  );
  expect(button('files.readMore').disabled).toBe(true);
  expect(host.querySelector('pre')?.textContent).toBe(
    '\\documentclass{article}',
  );
  await act(async () => button('files.refresh').click());
  expect(mocks.read.mock.calls.at(-1)?.[1]).toEqual({ path: '/source.tex' });
  expect(host.querySelector('pre')?.textContent).toBe('replacement');
});
