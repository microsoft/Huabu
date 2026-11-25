// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { standaloneThreadsOf } from '@/store/spaceThreads';
import { useWorkspaceStore } from '@/store/workspaceStore';
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

    // A browser page shows its own notifications; each is kept with the
    // conversations it tells of until it is closed.
    const shown = new Map<Notification, readonly string[]>();
    const inFront = () =>
      document.visibilityState === 'visible' && document.hasFocus();
    const notifyFromBrowser = (notice: DesktopTabNotice) => {
      if (typeof Notification === 'undefined') return;
      // The page in front needs none; a hidden or unfocused one gets a
      // system notification when the browser allows it.
      if (inFront() || Notification.permission !== 'granted') return;
      // One notification per conversation: a newer notice takes the place of
      // every one that told of a conversation it tells of.
      for (const [earlier, keys] of [...shown])
        if (keys.some((key) => notice.keys.includes(key))) earlier.close();
      const notification = new Notification(notice.title, {
        body: notice.body,
        silent: true,
      });
      shown.set(notification, notice.keys);
      // Where it leads is fixed now: the Space and Workspace it was made in,
      // whatever the page shows by the time it is clicked.
      const workspaceId = useWorkspaceStore.getState().workspaceId;
      notification.onclose = () => shown.delete(notification);
      notification.onclick = () => {
        window.focus();
        navigate(`/canvas/${encodeURIComponent(canvasId)}`, {
          state:
            notice.nodeIds.length > 0
              ? { focusNodeIds: notice.nodeIds, workspaceId }
              : undefined,
        });
        notification.close();
      };
    };
    // Coming back to the page is coming back to the Space: what it was told
    // of is in front of the person now.
    const withdraw = () => {
      if (!inFront()) return;
      for (const notification of [...shown.keys()]) notification.close();
    };
    document.addEventListener('visibilitychange', withdraw);
    window.addEventListener('focus', withdraw);

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
      else notifyFromBrowser(notice);
    };

    const read = () => {
      readTimer = undefined;
      const canvas = useCanvasStore.getState();
      if (canvas.canvasId !== canvasId || canvas.isLoading) return;
      const events = watcher.take(
        readConversations(
          canvas.nodes,
          useChatStore.getState().threadsById,
          standaloneThreadsOf(canvasId),
        ),
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
      document.removeEventListener('visibilitychange', withdraw);
      window.removeEventListener('focus', withdraw);
      // Nothing after this would withdraw or replace them: the page has
      // left this Space, or is going away.
      for (const notification of [...shown.keys()]) notification.close();
      unsubscribeCanvas();
      unsubscribeChat();
    };
  }, [canvasId, navigate]);
}
