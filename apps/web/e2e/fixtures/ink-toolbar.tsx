// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ReactFlow, useStoreApi } from '@xyflow/react';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { StrokeSelectionToolbar } from '@/components/Panels/Canvas/FloatingToolbars/StrokeSelectionToolbar';
import { createAreaSelectionSession } from '@/hooks/areaSelectionSession';
import { useInputModeStore } from '@/hooks/useInputMode';
import { i18n } from '@/i18n';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import { useGesturePreviewStore } from '@/store/gesturePreviewStore';

import '@xyflow/react/dist/style.css';
import '@/components/Panels/Canvas/FloatingToolbars/NodeToolbar.css';

let flowStore: ReturnType<typeof useStoreApi> | null = null;

function ToolbarHarness() {
  const store = useStoreApi();
  useEffect(() => {
    flowStore = store;
    return () => {
      flowStore = null;
    };
  }, [store]);
  return <StrokeSelectionToolbar />;
}

export async function mountInkToolbar(locale: string, conversationCount = 0) {
  await i18n.changeLanguage(locale);
  useInputModeStore.setState({ mode: 'touch' });
  useAcpProfilesStore.setState({
    profiles: [
      {
        id: 'ink-layout-profile',
        alias: 'GitHub Copilot (long-machine-name.example: darwin arm64)',
        agentletId: 'fixture-machine',
        workingDirPath: '/fixture',
        launch: { kind: 'acp-command', command: 'copilot --acp' },
      },
    ],
    selectableProfileIds: ['ink-layout-profile'],
    recentConversationProfileId: 'ink-layout-profile',
    loaded: true,
    error: null,
    refresh: async () => {},
  });
  // Exercise the production toolbar without creating or modifying a Space.
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'ink-layout-fixture',
    nodes: [
      {
        id: 'ink-layout-sketch',
        type: 'sketch',
        position: { x: 100, y: 200 },
        data: {
          strokes: [
            {
              id: 'ink-layout-stroke',
              points: [
                [20, 20, 0.5],
                [80, 100, 0.5],
              ],
              color: 'teal',
              size: 8,
              createdAt: 1,
            },
          ],
        },
      },
      ...Array.from({ length: conversationCount }, (_, index) => ({
        id: `ink-conversation-${index}`,
        type: 'question',
        position: { x: 300 + index * 150, y: 300 },
        data: {
          label: `Conversation ${index + 1}`,
          threadId: `ink-thread-${index}`,
          agentBinding: { kind: 'internal' },
          agentMode: 'ask',
        },
      })),
    ],
    edges: [],
    pendingForkThreadIds: {},
  });
  useGesturePreviewStore.setState({
    sketchStrokeSelection: { 'ink-layout-sketch': ['ink-layout-stroke'] },
    sketchSelectionPolygon: [
      { x: 100, y: 200 },
      { x: 220, y: 200 },
      { x: 220, y: 320 },
      { x: 100, y: 320 },
    ],
    sketchStrokeMovePreview: null,
    sketchSelectionSession: {},
  });
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;inset:0;background:var(--bg-default);z-index:900';
  document.body.append(host);
  createRoot(host).render(
    <ReactFlow nodes={[]} edges={[]}>
      <ToolbarHarness />
    </ReactFlow>,
  );
}

export async function renewInkSelection() {
  const preview = useGesturePreviewStore.getState();
  preview.commitSketchSelection(preview.sketchSelectionPolygon);
}

export async function cancelReplacementInkSelection() {
  if (!flowStore) throw new Error('Ink toolbar fixture is not mounted');
  const gesture = createAreaSelectionSession(true);
  flowStore.setState({ userSelectionActive: true });
  gesture.preview(null);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  gesture.cancel();
  flowStore.setState({ userSelectionActive: false });
}
