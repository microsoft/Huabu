// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';

import { toast } from '@/components/Common/Toast';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { PDFPreview } from './PDFPreview';

import type { PDFPageWithOverlay } from './PDFPageWithOverlay';
import type * as ArtifactApi from '@/api/artifact';
import type { FloatingDragHandle } from '@/components/Nodes/FloatingDragHandle';
import type { Document } from 'react-pdf';

const mocks = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  document: null as ComponentProps<typeof Document>['onLoadSuccess'] | null,
  page: vi.fn<(props: ComponentProps<typeof PDFPageWithOverlay>) => void>(),
  capture: vi.fn<(props: ComponentProps<typeof FloatingDragHandle>) => void>(),
}));
vi.mock('@/api/acp', () => ({ listAcpProfiles: mocks.listProfiles }));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/Common/Loading', () => ({ Loading: () => <div /> }));
vi.mock('@/api/artifact', async (original) => ({
  ...(await original<typeof ArtifactApi>()),
  resolveArtifactUrl: (src: string) => src,
  uploadImage: vi.fn().mockResolvedValue('artifact://canvas-1/capture.png'),
}));
vi.mock('./pdfWorker', () => ({ PDF_DOCUMENT_OPTIONS: {} }));
vi.mock('./usePdfTextIndex', () => ({
  usePdfTextIndex: () => ({ pages: new Map(), isIndexing: false }),
}));
vi.mock('react-pdf', () => ({
  Document: (props: { children: ReactNode; onLoadSuccess: () => void }) => {
    mocks.document = props.onLoadSuccess;
    return props.children;
  },
}));
vi.mock('./PDFPageWithOverlay', () => ({
  PDFPageWithOverlay: (props: ComponentProps<typeof PDFPageWithOverlay>) => {
    mocks.page(props);
    return <div />;
  },
}));
vi.mock('../FloatingDragHandle', () => ({
  FloatingDragHandle: (props: ComponentProps<typeof FloatingDragHandle>) => {
    mocks.capture(props);
    return <div />;
  },
}));

const profileSnapshot = {
  profiles: [],
  selectableProfileIds: [],
  agentlet: null,
  agentDefaults: null,
};
const attachment = {
  type: 'image' as const,
  source: 'excerpt' as const,
  url: 'artifact://canvas-1/capture.png',
  content: 'Private PDF excerpt from workspace-1',
  originNodeId: 'pdf-1',
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.listProfiles.mockReset().mockResolvedValue(profileSnapshot);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  useWorkspaceStore.setState({ workspaceId: 'workspace-1' });
  useCanvasStore.setState({ canvasId: 'canvas-1', nodes: [], edges: [] });
  useChatStore.setState({
    threadsById: {},
    threadMap: {},
    bindingMap: {},
    bindingByThread: {},
  });
  useAcpProfilesStore.setState({
    loaded: false,
    error: null,
    profiles: [],
    selectableProfileIds: [],
    agentDefaults: null,
    defaultsError: null,
    recentConversationProfileId: null,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'canvas-1',
    workspace: createEmptyWorkspace(),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function capturePdf() {
  act(() =>
    root.render(<PDFPreview id="pdf-1" data={{ src: 'document.pdf' }} />),
  );
  act(() =>
    mocks.document?.({ numPages: 1 } as Parameters<
      NonNullable<ComponentProps<typeof Document>['onLoadSuccess']>
    >[0]),
  );
  const page = mocks.page.mock.lastCall?.[0];
  assert(page);
  await act(async () =>
    page.onAreaCaptured({
      pageIndex: 0,
      position: { x: 10, y: 10 },
      captureRect: { x: 0, y: 0, width: 0.5, height: 0.5 },
      getBlob: async () => new Blob(['capture'], { type: 'image/png' }),
      getText: async () => attachment.content,
    }),
  );
  const capture = mocks.capture.mock.lastCall?.[0];
  assert(capture?.onSendToChat);
  return capture.onSendToChat;
}

async function offerRetry() {
  const send = await capturePdf();
  await act(async () => send(attachment));
  const action = vi.mocked(toast).mock.calls[0]?.[1]?.action;
  assert(action);
  return action;
}

it('retries attaching the PDF excerpt in the initiating Workspace', async () => {
  const action = await offerRetry();
  await act(async () => action.onClick());
  const chat = useChatStore.getState();
  expect(
    chat.threadsById[chat.threadMap['canvas-1']].pendingAttachments,
  ).toEqual([attachment]);
});

it.each(['new fallback', 'existing chat', 'adjacent conversation'])(
  'does not attach a retained PDF excerpt to another Workspace with a matching Space ID (%s)',
  async (destination) => {
    const action = await offerRetry();
    act(() => {
      useWorkspaceStore.setState({ workspaceId: 'workspace-2' });
      // Retain the same layout object to isolate the backend identity check.
      if (destination === 'existing chat')
        useChatStore
          .getState()
          .ensureCanvasThread('canvas-1', { kind: 'internal' });
      if (destination === 'adjacent conversation') {
        usePreviewWorkspaceStore.getState().openPreviewTarget({
          kind: 'node',
          canvasId: 'canvas-1',
          nodeId: 'pdf-1',
        });
        usePreviewWorkspaceStore.getState().openPreviewTarget(
          {
            kind: 'chat',
            canvasId: 'canvas-1',
            threadId: 'other-workspace-thread',
          },
          { openToSide: true },
        );
      }
    });
    const chat = useChatStore.getState();
    const preview = usePreviewWorkspaceStore.getState().workspace;
    const requests = mocks.listProfiles.mock.calls.length;
    await act(async () => action.onClick());
    expect(mocks.listProfiles).toHaveBeenCalledTimes(requests);
    expect(useChatStore.getState()).toBe(chat);
    expect(usePreviewWorkspaceStore.getState().workspace).toBe(preview);
  },
);

it('does not attach when the Workspace changes while loading the retry binding', async () => {
  const action = await offerRetry();
  let resolve!: (value: typeof profileSnapshot) => void;
  mocks.listProfiles.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  act(() => action.onClick());
  await vi.waitFor(() => expect(mocks.listProfiles).toHaveBeenCalledTimes(2));
  act(() => useWorkspaceStore.setState({ workspaceId: 'workspace-2' }));
  await act(async () => resolve(profileSnapshot));
  expect(useChatStore.getState().threadsById).toEqual({});
  expect(useChatStore.getState().threadMap).toEqual({});
});
