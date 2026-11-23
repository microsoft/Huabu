// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { readNoticePreferences } from '@/utils/turnNoticePreferences';
import {
  composeNotice,
  createTurnWatcher,
  readConversations,
  type TurnEvent,
} from '@/utils/turnNotices';
import { markTouches } from '@/utils/unseenChanges';

import { getElectronBridge } from './useElectron';
import { readUnseenMarks } from './useUnseenChanges';

import type { DesktopTabNotice } from '@huabu/shared/desktop-tabs';

/** Events this close together are told as one notice. */
const GATHER_MS = 1_000;

/**
 * Show a notice from a browser page. The page in front needs none; a hidden
 * or unfocused one gets a system notification when the browser allows it.
 */
function notifyFromBrowser(
  notice: DesktopTabNotice,
  open: (nodeIds: string[]) => void,
): void {
  if (typeof Notification === 'undefined') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  if (Notification.permission !== 'granted') return;
  // The tag makes a conversation's newer notification replace its older one.
  const notification = new Notification(notice.title, {
    body: notice.body,
    tag: notice.key,
    silent: true,
  });
  notification.onclick = () => {
    window.focus();
    open(notice.nodeIds);
    notification.close();
  };
}

/**
 * Tell a person who is elsewhere that an Agent in this Space finished,
 * failed, or waits for them. In the desktop app the main process decides
 * what to show; in a browser this page does.
 */
export function useTurnNotices(canvasId: string | undefined): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!canvasId) return;
    const tabs = getElectronBridge()?.tabs;
    const watcher = createTurnWatcher();
    let gathered: TurnEvent[] = [];
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    let tellTimer: ReturnType<typeof setTimeout> | undefined;

    const tell = () => {
      tellTimer = undefined;
      const unseen = [...readUnseenMarks()];
      const events = gathered.map((event) => ({
        ...event,
        outputIds: unseen.flatMap(([nodeId, mark]) =>
          markTouches(mark, event.key) ? [nodeId] : [],
        ),
      }));
      gathered = [];
      const notice = composeNotice(
        events,
        useCanvasStore.getState().canvasTitle || i18n.t('canvasList.untitled'),
        {
          done: i18n.t('turnNotices.done'),
          error: i18n.t('turnNotices.error'),
          approval: i18n.t('turnNotices.approval'),
          several: (count) => i18n.t('turnNotices.several', { count }),
        },
        readNoticePreferences(),
      );
      if (!notice) return;
      if (tabs) tabs.notify?.(notice);
      else
        notifyFromBrowser(notice, (nodeIds) => {
          if (nodeIds.length === 0) return;
          navigate(
            `${window.location.pathname}${window.location.search}${window.location.hash}`,
            { state: { focusNodeIds: nodeIds } },
          );
        });
    };

    const read = () => {
      readTimer = undefined;
      const canvas = useCanvasStore.getState();
      if (canvas.canvasId !== canvasId || canvas.isLoading) return;
      const events = watcher.take(
        readConversations(canvas.nodes, useChatStore.getState().threadsById),
      );
      if (events.length === 0) return;
      gathered.push(...events);
      tellTimer ??= setTimeout(tell, GATHER_MS);
    };
    const schedule = () => {
      readTimer ??= setTimeout(read, 100);
    };

    const unsubscribeCanvas = useCanvasStore.subscribe(schedule);
    const unsubscribeChat = useChatStore.subscribe(schedule);
    read();
    return () => {
      clearTimeout(readTimer);
      clearTimeout(tellTimer);
      unsubscribeCanvas();
      unsubscribeChat();
    };
  }, [canvasId, navigate]);
}
