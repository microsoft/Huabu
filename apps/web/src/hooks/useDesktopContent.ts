// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { getQuestionNodeStatus } from '@huabu/shared';

import { toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { useChatPreferencesStore } from '@/store/chatPreferencesStore';
import { useChatStore } from '@/store/chatStore';
import { ConversationTitleSaveError } from '@/store/conversationTitleStore';
import { useDesktopTabStore } from '@/store/desktopTabStore';
import { useSettingsUiStore } from '@/store/settingsUiStore';
import { useToolStore } from '@/store/toolStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import {
  isDesktopInputFrozen,
  setDesktopInputFrozen,
} from '@/utils/desktopInput';
import { desktopNavigationPath } from '@/utils/desktopNavigation';
import {
  readApplicationPreference,
  subscribeApplicationPreferences,
} from '@/utils/desktopStorage';
import { pageLifecycle } from '@/utils/pageLifecycle';

import { getElectronBridge, requireDesktopTabSuccess } from './useElectron';

import type {
  DesktopPreferenceKey,
  DesktopTabReport,
  DesktopTabsSnapshot,
} from '@huabu/shared/desktop-tabs';

export { requireDesktopTabSuccess } from './useElectron';

export function useDesktopContent(): {
  saving: boolean;
  preparingClose: boolean;
  cancelClose: () => void;
} {
  const tabs = getElectronBridge()?.tabs;
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [preparingClose, setPreparingClose] = useState(false);
  const closeRequest = useRef<{
    id: string;
    controller: AbortController;
    overlayTimer?: number;
  } | null>(null);
  const cancelClose = useCallback(() => {
    const request = closeRequest.current;
    if (!request) return;
    window.clearTimeout(request.overlayTimer);
    request.controller.abort();
    closeRequest.current = null;
    tabs?.finishPrepareClose(request.id, {
      ok: false,
      error: 'Closing was cancelled.',
      cancelled: true,
    });
  }, [tabs]);
  const workspaceId = useWorkspaceStore((state) =>
    state.isReady ? state.workspaceId : null,
  );
  const workspaceSyncing = useWorkspaceStore((state) => state.isSyncing);

  useEffect(() => {
    if (!tabs || tabs.context.role !== 'space') return;
    let live = true;
    let received = false;
    const update = (snapshot: DesktopTabsSnapshot) => {
      useDesktopTabStore.setState({
        isActive:
          snapshot.workspaceId === tabs.context.workspaceId &&
          snapshot.tabs.some(
            (tab) =>
              tab.id === snapshot.activeId &&
              tab.canvasId === tabs.context.canvasId,
          ),
      });
    };
    const unsubscribe = tabs.onState((snapshot) => {
      received = true;
      update(snapshot);
    });
    void tabs
      .getState()
      .then((snapshot) => {
        if (live && !received) update(snapshot);
      })
      .catch((error: unknown) => {
        if (!live) return;
        console.error('[desktop-tabs] Could not read Tab activation:', error);
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      });
    return () => {
      live = false;
      unsubscribe();
      useDesktopTabStore.setState({ isActive: false });
    };
  }, [tabs]);

  useEffect(() => {
    if (!tabs || tabs.context.role === 'shell') return;
    const reportSaveError = (error: unknown): string => {
      const message =
        error instanceof Error
          ? error.cause instanceof Error
            ? error.cause.message
            : error.message
          : String(error);
      console.error('[desktop-tabs] Could not save Space:', error);
      toast(message, {
        tone: 'danger',
        ...(error instanceof ConversationTitleSaveError
          ? {
              action: {
                label: i18n.t('chat.retryTitleSave'),
                onClick: () => {
                  void error.retry().catch(reportSaveError);
                },
              },
            }
          : {}),
      });
      return message;
    };
    const unsubscribeNavigate = tabs.onNavigate((target) => {
      navigate(desktopNavigationPath(target), { state: target.state });
    });
    const unsubscribePrepare = tabs.onPrepareClose((requestId) => {
      closeRequest.current?.controller.abort();
      const request: NonNullable<typeof closeRequest.current> = {
        id: requestId,
        controller: new AbortController(),
      };
      closeRequest.current = request;
      setDesktopInputFrozen(true);
      setPreparingClose(true);
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      request.overlayTimer = window.setTimeout(() => {
        if (closeRequest.current === request) setSaving(true);
      }, 150);
      const heartbeat = window.setInterval(() => {
        if (closeRequest.current === request)
          tabs.keepPrepareCloseAlive(requestId);
      }, 5_000);
      void (async () => {
        try {
          await pageLifecycle.prepare(request.controller.signal);
          if (closeRequest.current === request) {
            tabs.finishPrepareClose(requestId, { ok: true });
          }
        } catch (error) {
          if (
            closeRequest.current !== request ||
            request.controller.signal.aborted
          )
            return;
          const message = reportSaveError(error);
          window.clearTimeout(request.overlayTimer);
          setSaving(false);
          tabs.finishPrepareClose(requestId, { ok: false, error: message });
        } finally {
          window.clearInterval(heartbeat);
        }
      })();
    });
    const unsubscribePrepared = tabs.onClosePrepared(() => {
      window.clearTimeout(closeRequest.current?.overlayTimer);
      closeRequest.current?.controller.abort();
      closeRequest.current = null;
      setSaving(false);
    });
    const unsubscribeResume = tabs.onResume(() => {
      window.clearTimeout(closeRequest.current?.overlayTimer);
      closeRequest.current?.controller.abort();
      closeRequest.current = null;
      setDesktopInputFrozen(false);
      setSaving(false);
      setPreparingClose(false);
    });
    tabs.ready();
    return () => {
      window.clearTimeout(closeRequest.current?.overlayTimer);
      closeRequest.current?.controller.abort();
      closeRequest.current = null;
      setDesktopInputFrozen(false);
      unsubscribeNavigate();
      unsubscribePrepare();
      unsubscribeResume();
      unsubscribePrepared();
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
    let previous: DesktopTabReport | undefined;
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
      const next: DesktopTabReport = {
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
      };
      if (
        previous &&
        previous.title === next.title &&
        previous.running === next.running &&
        previous.completion === next.completion &&
        previous.error === next.error
      )
        return;
      previous = next;
      tabs.report(next);
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
    const hydratePreference = (key: DesktopPreferenceKey) => {
      try {
        if (key === 'huabu-sketch-tools') void useToolStore.persist.rehydrate();
        if (key === 'huabu-chat-preferences')
          void useChatPreferencesStore.persist.rehydrate();
        if (key === 'huabu:world-enabled')
          useWorkspaceStore.setState({
            worldEnabled: readApplicationPreference(key) === 'true',
          });
        if (key === 'huabu.minimapEnabled')
          useCanvasStore.setState({
            minimapEnabled: readApplicationPreference(key) === 'true',
          });
      } catch (error) {
        console.error(
          '[desktop-tabs] Could not hydrate preference:',
          key,
          error,
        );
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      }
    };
    const unsubscribe = subscribeApplicationPreferences(hydratePreference);
    hydratePreference('huabu-sketch-tools');
    hydratePreference('huabu-chat-preferences');
    hydratePreference('huabu:world-enabled');
    hydratePreference('huabu.minimapEnabled');
    return unsubscribe;
  }, [tabs]);

  return { saving, preparingClose, cancelClose };
}
