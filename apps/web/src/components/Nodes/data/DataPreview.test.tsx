// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getNodeContent: vi.fn(),
  putNodeContent: vi.fn(),
  adoptRemoteNodeContent: vi.fn(),
  canWrite: true,
  canvasId: 'canvas-1' as string | null,
}));

vi.mock('@/api/canvas', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getNodeContent: mocks.getNodeContent,
    putNodeContent: mocks.putNodeContent,
  };
});

vi.mock('@/store/canvasStore', () => ({
  default: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      canvasId: mocks.canvasId,
      accessRole: mocks.canWrite ? 'owner' : 'viewer',
    }),
  selectCanWriteCanvas: () => mocks.canWrite,
  adoptRemoteNodeContent: mocks.adoptRemoteNodeContent,
}));

vi.mock('@/hooks/useElectron', () => ({
  getElectronBridge: () => null,
}));

import '@/i18n';
import { CanvasConflictError } from '@/api/canvas';

import { DataPreview } from './DataPreview';

import type { DataNodeSchemaV1 } from '@huabu/shared/data-node-validation';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const testSchema: DataNodeSchemaV1 = {
  type: 'object',
  properties: {
    repo: { type: 'string', minLength: 1 },
    confirmedByUser: { type: 'boolean' },
  },
  required: ['repo', 'confirmedByUser'],
  additionalProperties: false,
};

function setNativeValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('DataPreview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canWrite = true;
    mocks.canvasId = 'canvas-1';
    mocks.adoptRemoteNodeContent.mockResolvedValue(undefined);
    mocks.getNodeContent.mockResolvedValue({
      content: '{\n  "repo": "microsoft/Huabu",\n  "confirmedByUser": true\n}',
      rev: 'rev-server-1',
      dataSchema: testSchema,
      contentMissing: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens in Read-Only mode by default and hides Edit for read-only viewers', async () => {
    await act(async () => {
      root.render(
        <DataPreview
          id="node-data-1"
          data={{
            label: 'Tracker Config',
            content: '{"repo":"microsoft/Huabu","confirmedByUser":true}',
            dataSchema: testSchema,
          }}
        />,
      );
    });

    expect(
      container.querySelector('[data-testid="data-preview-readonly-json"]')
        ?.textContent,
    ).toContain('"repo": "microsoft/Huabu"');
    expect(
      container.querySelector('[data-testid="data-preview-editor"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="data-preview-edit"]'),
    ).not.toBeNull();

    // Viewer mode hides Edit button
    await act(async () => {
      root.render(
        <DataPreview
          id="node-data-1"
          readOnly
          data={{
            label: 'Tracker Config',
            content: '{"repo":"microsoft/Huabu","confirmedByUser":true}',
            dataSchema: testSchema,
          }}
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="data-preview-edit"]'),
    ).toBeNull();
  });

  it('validates draft against dataSchema and prohibited secret keys before allowing CAS save', async () => {
    mocks.putNodeContent.mockResolvedValueOnce({ rev: 'rev-server-2' });

    await act(async () => {
      root.render(
        <DataPreview
          id="node-data-1"
          data={{
            label: 'Tracker Config',
            content: '{"repo":"microsoft/Huabu","confirmedByUser":true}',
            dataSchema: testSchema,
          }}
        />,
      );
    });

    const editBtn = container.querySelector(
      '[data-testid="data-preview-edit"]',
    ) as HTMLButtonElement;
    await act(async () => {
      editBtn.click();
      await Promise.resolve();
    });

    const editor = container.querySelector(
      '[data-testid="data-preview-editor"]',
    ) as HTMLTextAreaElement;
    const saveBtn = container.querySelector(
      '[data-testid="data-preview-save"]',
    ) as HTMLButtonElement;
    expect(editor).not.toBeNull();

    // Schema violation disables Save and renders error
    await act(async () => {
      setNativeValue(editor, '{"repo": ""}');
    });
    expect(saveBtn.disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="data-preview-validation-error"]'),
    ).not.toBeNull();

    // Prohibited secret key even without schema restriction is rejected
    await act(async () => {
      root.render(
        <DataPreview
          id="node-data-untyped"
          data={{
            label: 'Untyped Data',
            content: '{"safe":true}',
          }}
        />,
      );
    });
    mocks.getNodeContent.mockResolvedValueOnce({
      content: '{\n  "safe": true\n}',
      rev: 'rev-u1',
      contentMissing: false,
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="data-preview-edit"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    const untypedEditor = container.querySelector(
      '[data-testid="data-preview-editor"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(untypedEditor, '{"apiToken":"secret-123"}');
    });
    expect(
      (
        container.querySelector(
          '[data-testid="data-preview-save"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="data-preview-validation-error"]')
        ?.textContent,
    ).toContain('apiToken');

    // Valid edit saves via putNodeContent with expectRev and exits edit mode
    await act(async () => {
      setNativeValue(untypedEditor, '{"safe":false}');
    });
    const validSaveBtn = container.querySelector(
      '[data-testid="data-preview-save"]',
    ) as HTMLButtonElement;
    expect(validSaveBtn.disabled).toBe(false);
    await act(async () => {
      validSaveBtn.click();
      await Promise.resolve();
    });
    expect(mocks.putNodeContent).toHaveBeenCalledWith(
      'canvas-1',
      'node-data-untyped',
      {
        nodeType: 'data',
        content: '{\n  "safe": false\n}',
        expectRev: 'rev-u1',
      },
    );
    expect(mocks.adoptRemoteNodeContent).toHaveBeenCalledWith('canvas-1', [
      'node-data-untyped',
    ]);
    expect(
      container.querySelector('[data-testid="data-preview-editor"]'),
    ).toBeNull();
  });

  it('preserves user draft on 409 CAS conflict and supports Overwrite or Reload, plus dirty Escape discard confirmation', async () => {
    await act(async () => {
      root.render(
        <DataPreview
          id="node-data-1"
          data={{
            label: 'Tracker Config',
            content: '{"repo":"microsoft/Huabu","confirmedByUser":true}',
            dataSchema: testSchema,
          }}
        />,
      );
    });

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="data-preview-edit"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });

    const editor = container.querySelector(
      '[data-testid="data-preview-editor"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(
        editor,
        '{\n  "repo": "microsoft/MyDraft",\n  "confirmedByUser": false\n}',
      );
    });

    // Escape while dirty intercepts and opens confirmation modal instead of discarding draft
    const escapeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(escapeEvent);
    });
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(
      document.querySelector('[data-testid="data-preview-keep-editing"]'),
    ).not.toBeNull();
    await act(async () => {
      (
        document.querySelector(
          '[data-testid="data-preview-keep-editing"]',
        ) as HTMLButtonElement
      ).click();
    });

    // Simulate 409 conflict on Save
    mocks.putNodeContent.mockRejectedValueOnce(
      new CanvasConflictError({
        code: 'NODE_CONTENT_CONFLICT',
        message: 'Node content revision mismatch',
        currentRev: 'rev-remote-9',
      }),
    );
    mocks.getNodeContent.mockResolvedValueOnce({
      content:
        '{\n  "repo": "microsoft/RemoteWin",\n  "confirmedByUser": true\n}',
      rev: 'rev-remote-9',
      dataSchema: testSchema,
      contentMissing: false,
    });

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="data-preview-save"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Draft is preserved and conflict banner is displayed
    expect(editor.value).toContain('microsoft/MyDraft');
    expect(
      container.querySelector('[data-testid="data-preview-conflict-banner"]'),
    ).not.toBeNull();

    // Overwrite uses latest rev-remote-9
    mocks.putNodeContent.mockResolvedValueOnce({ rev: 'rev-server-10' });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="data-preview-conflict-overwrite"]',
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    expect(mocks.putNodeContent).toHaveBeenLastCalledWith(
      'canvas-1',
      'node-data-1',
      {
        nodeType: 'data',
        content:
          '{\n  "repo": "microsoft/MyDraft",\n  "confirmedByUser": false\n}',
        expectRev: 'rev-remote-9',
      },
    );
  });
});
