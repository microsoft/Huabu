// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { uploadAudio } from '@/api/artifact';
import { setDesktopInputFrozen } from '@/utils/desktopInput';
import { pageLifecycle } from '@/utils/pageLifecycle';

import { AudioNode } from './AudioNode';

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('@/api/artifact', () => ({
  uploadAudio: vi.fn(),
  resolveArtifactUrl: (src: string) => src,
}));
vi.mock('@/store/canvasStore.ts', () => ({
  default: (selector: (state: object) => unknown) =>
    selector({
      canvasId: 'space',
      updateNodeData: mocks.update,
    }),
}));
vi.mock('../NodeWrapper', () => ({
  NodeWrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  setDesktopInputFrozen(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([false, true])(
  'stops capture and awaits upload even when microphone permission is pending=%s',
  async (pendingPermission) => {
    let allowMicrophone!: (stream: object) => void;
    const media = new Promise<object>((resolve) => {
      allowMicrophone = resolve;
    });
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(() => media) },
    });
    const stopped = vi.fn();
    vi.stubGlobal(
      'MediaRecorder',
      class {
        static isTypeSupported() {
          return true;
        }
        state = 'inactive';
        mimeType = 'audio/webm';
        ondataavailable?: (event: { data: Blob }) => void;
        onstop?: () => Promise<void>;
        start() {
          this.state = 'recording';
        }
        stop() {
          this.state = 'inactive';
          stopped();
          queueMicrotask(() => {
            this.ondataavailable?.({ data: new Blob(['audio']) });
            void this.onstop?.();
          });
        }
      },
    );
    let uploaded!: (uri: string) => void;
    vi.mocked(uploadAudio)
      .mockReset()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          uploaded = resolve;
        }),
      );
    mocks.update.mockClear();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <AudioNode
            id="audio"
            type="audio"
            data={{ type: 'audio', src: '' }}
            selected={false}
            dragging={false}
            zIndex={0}
            isConnectable
            draggable
            selectable
            deletable
            positionAbsoluteX={0}
            positionAbsoluteY={0}
          />,
        ),
      );
      if (!pendingPermission) allowMicrophone(stream);
      await act(async () => container.querySelector('button')?.click());
      setDesktopInputFrozen(true);
      let finished = false;
      const close = pageLifecycle
        .prepare(new AbortController().signal, vi.fn())
        .then(() => {
          finished = true;
        });
      await act(async () => {
        if (pendingPermission) allowMicrophone(stream);
      });
      expect(stopped).toHaveBeenCalledOnce();
      expect(uploadAudio).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      expect(mocks.update).not.toHaveBeenCalled();
      await act(async () => {
        uploaded('recording.webm');
        await close;
      });
      expect(mocks.update).toHaveBeenCalledWith('audio', {
        src: 'recording.webm',
      });
      expect(stopTrack).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  },
);
