// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { getQuestionNodeStatus } from '@huabu/shared';

import { toast } from '@/components/Common/Toast';
import useCanvasStore, {
  flushCanvasViewState,
  saveCanvasForSubmission,
} from '@/store/canvasStore';
import { useChatPreferencesStore } from '@/store/chatPreferencesStore';
import { useChatStore } from '@/store/chatStore';
import { useSettingsUiStore } from '@/store/settingsUiStore';
import { useToolStore } from '@/store/toolStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import {
  isDesktopInputFrozen,
  setDesktopInputFrozen,
} from '@/utils/desktopInput';
import { desktopNavigationPath } from '@/utils/desktopNavigation';

import { getElectronBridge, requireDesktopTabSuccess } from './useElectron';

export { requireDesktopTabSuccess } from './useElectron';

export function useDesktopContent(): {
  saving: boolean;
  preparingClose: boolean;
} {
  const tabs = getElectronBridge()?.tabs;
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [preparingClose, setPreparingClose] = useState(false);
  const workspaceId = useWorkspaceStore((state) =>
    state.isReady ? state.workspaceId : null,
  );
  const workspaceSyncing = useWorkspaceStore((state) => state.isSyncing);

  useEffect(() => {
    if (!tabs || tabs.context.role === 'shell') return;
    let activeRequestId: string | null = null;
    const unsubscribeNavigate = tabs.onNavigate((target) => {
      navigate(desktopNavigationPath(target), { state: target.state });
    });
    const unsubscribePrepare = tabs.onPrepareClose((requestId) => {
      activeRequestId = requestId;
      setDesktopInputFrozen(true);
      setPreparingClose(true);
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      const canvasId = useCanvasStore.getState().canvasId;
      const overlayTimer = canvasId
        ? window.setTimeout(() => {
            if (activeRequestId === requestId) setSaving(true);
          }, 150)
        : undefined;
      void (async () => {
        try {
          if (canvasId) await saveCanvasForSubmission(canvasId);
          flushCanvasViewState();
          tabs.finishPrepareClose(requestId, { ok: true });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error('[desktop-tabs] Could not save Space:', error);
          toast(message, { tone: 'danger' });
          tabs.finishPrepareClose(requestId, { ok: false, error: message });
        } finally {
          window.clearTimeout(overlayTimer);
          if (activeRequestId === requestId) setSaving(false);
        }
      })();
    });
    const unsubscribeResume = tabs.onResume(() => {
      activeRequestId = null;
      setDesktopInputFrozen(false);
      setSaving(false);
      setPreparingClose(false);
    });
    tabs.ready();
    return () => {
      activeRequestId = null;
      setDesktopInputFrozen(false);
      unsubscribeNavigate();
      unsubscribePrepare();
      unsubscribeResume();
    };
  }, [tabs, navigate]);

  useEffect(() => {
    const bridge = getElectronBridge();
    if (!tabs || bridge?.platform === 'darwin') return;
    return bridge?.menu?.onCommand((command) => {
      if (isDesktopInputFrozen()) return;
      if (command === 'open-settings') useSettingsUiStore.getState().open();
    });
  }, [tabs]);

  useEffect(() => {
    if (
      !tabs ||
      tabs.context.role !== 'home' ||
      !workspaceId ||
      workspaceSyncing
    )
      return;
    void tabs
      .workspaceReady(workspaceId)
      .then(requireDesktopTabSuccess)
      .catch((error: unknown) => {
        console.error('[desktop-tabs] Workspace registration failed:', error);
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      });
  }, [tabs, workspaceId, workspaceSyncing]);

  useEffect(() => {
    if (!tabs || tabs.context.role === 'shell') return;
    const report = () => {
      const canvas = useCanvasStore.getState();
      if (
        tabs.context.role === 'space' &&
        (canvas.canvasId !== tabs.context.canvasId || canvas.isLoading)
      )
        return;
      const questions = canvas.nodes.filter(
        (node) => node.data.type === 'question',
      );
      const threads = Object.entries(useChatStore.getState().threadsById);
      const errorNode = questions.find(
        (node) => getQuestionNodeStatus(node.data) === 'error',
      );
      const errorThread = threads.find(([, thread]) => {
        const last = thread.messages.at(-1);
        return last?.role === 'status' && last.status === 'error';
      });
      const errorMessage = errorThread?.[1].messages.at(-1);
      tabs.report({
        title:
          tabs.context.role === 'home'
            ? (useWorkspaceStore.getState().workspaceName ?? 'Home')
            : canvas.canvasTitle,
        running:
          questions.some(
            (node) => getQuestionNodeStatus(node.data) === 'running',
          ) || threads.some(([, thread]) => thread.isStreaming),
        completion: [
          ...questions.flatMap((node) =>
            getQuestionNodeStatus(node.data) === 'done'
              ? [`${node.id}:${node.data.invocationToken ?? ''}`]
              : [],
          ),
          ...threads.flatMap(([threadId, thread]) =>
            thread.completedTurnId
              ? [`${threadId}:${thread.completedTurnId}`]
              : [],
          ),
        ]
          .sort()
          .join('\0'),
        error: canvas.canvasNotFound
          ? 'Space no longer exists'
          : errorNode
            ? String(errorNode.data.errorMessage ?? 'Agent execution failed')
            : errorMessage?.role === 'status'
              ? (errorMessage.detail ?? 'Agent execution failed')
              : null,
      });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        report();
      }, 100);
    };
    const unsubscribeCanvas = useCanvasStore.subscribe(schedule);
    const unsubscribeChat = useChatStore.subscribe(schedule);
    const unsubscribeWorkspace = useWorkspaceStore.subscribe(schedule);
    report();
    return () => {
      clearTimeout(timer);
      unsubscribeCanvas();
      unsubscribeChat();
      unsubscribeWorkspace();
    };
  }, [tabs]);

  useEffect(() => {
    if (!tabs) return;
    const syncPreferences = (event: StorageEvent) => {
      if (event.key === 'huabu-sketch-tools')
        void useToolStore.persist.rehydrate();
      if (event.key === 'huabu-chat-preferences')
        void useChatPreferencesStore.persist.rehydrate();
      if (event.key === 'huabu:world-enabled')
        useWorkspaceStore.setState({
          worldEnabled: localStorage.getItem(event.key) === 'true',
        });
      if (event.key === 'huabu.minimapEnabled')
        useCanvasStore.setState({
          minimapEnabled: localStorage.getItem(event.key) === 'true',
        });
    };
    window.addEventListener('storage', syncPreferences);
    return () => window.removeEventListener('storage', syncPreferences);
  }, [tabs]);

  return { saving, preparingClose };
}
