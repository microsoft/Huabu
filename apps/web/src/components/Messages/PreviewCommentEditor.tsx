// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import {
  commentDestinationTitle,
  useCommentDestination,
} from '@/hooks/useCommentDestination';
import { useChatStore } from '@/store/chatStore';

import { FragmentCommentPopover } from './AIMessage/FragmentCommentPopover';
import { revealQuotedCommentDraft } from './quotedCommentNotification';

import type { FragmentCommentSelection } from './AIMessage/FragmentCommentPopover';
import type { QuotedComment } from '@huabu/shared';

export interface PreviewCommentCapture {
  selection: FragmentCommentSelection;
  source: NonNullable<QuotedComment['source']>;
}

export function PreviewCommentEditor({
  capture,
  onDismiss,
}: {
  capture: PreviewCommentCapture;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const target = useCommentDestination(capture.source.canvasId);
  const [stagingError, setStagingError] = useState(false);
  const [open, setOpen] = useState(false);
  const staged = useRef(false);
  const titleFor = (item: (typeof target.candidates)[number]) =>
    commentDestinationTitle(
      item,
      target.candidates,
      t('messages.commentUntitledDestination'),
    );
  const selected = target.candidates.find(
    (item) =>
      item.nodeId === target.destination?.nodeId &&
      item.threadId === target.destination.threadId,
  );
  const label = selected
    ? titleFor(selected)
    : t(
        target.loading
          ? 'messages.commentDestinationLoading'
          : target.destination
            ? 'messages.commentDestinationUnavailable'
            : 'messages.commentChooseDestination',
      );
  return (
    <FragmentCommentPopover
      selection={capture.selection}
      onDismiss={onDismiss}
      addDisabled={!target.available || target.loading}
      onAdd={(comment) => {
        if (staged.current) return;
        const view = target.resolve();
        if (!view) {
          setStagingError(true);
          return;
        }
        staged.current = true;
        useChatStore
          .getState()
          .addQuotedComment(view.conversationOwner.threadId, {
            quote: capture.selection.text,
            contextBefore: capture.selection.contextBefore,
            contextAfter: capture.selection.contextAfter,
            comment,
            source: capture.source,
          });
        target.rememberStaged(view.conversationOwner.threadId);
        onDismiss();
        revealQuotedCommentDraft(view, label);
      }}
    >
      {capture.source.kind === 'file-reference' ? (
        <p className="text-fg-muted text-xs break-all">
          {t('messages.commentCapturedFile')} · {capture.source.path}
        </p>
      ) : null}
      <DropdownMenu
        aria-label={t('messages.commentChooseDestination')}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            className="max-w-full"
            title={label}
            data-popover-dismiss-ignore=""
          >
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        }
      >
        {target.candidates.map((item) => (
          <DropdownMenuItem
            key={item.nodeId}
            title={titleFor(item)}
            disabled={!item.available}
            aria-current={
              target.destination?.nodeId === item.nodeId &&
              target.destination.threadId === item.threadId
                ? 'true'
                : undefined
            }
            onClick={() => {
              target.choose({ nodeId: item.nodeId, threadId: item.threadId });
              setStagingError(false);
              setOpen(false);
            }}
          >
            {titleFor(item)}
          </DropdownMenuItem>
        ))}
        {!target.candidates.length ? (
          <p role="status" className="text-fg-muted px-3 py-2 text-xs">
            {t('messages.commentNoDestinations')}
          </p>
        ) : null}
      </DropdownMenu>
      {target.error ? (
        <div role="alert" className="text-danger text-xs">
          {t('messages.commentDestinationFailed')}
          <Button variant="ghost" size="sm" onClick={target.retry}>
            {t('messages.commentRetry')}
          </Button>
        </div>
      ) : null}
      {target.temporary ? (
        <p role="status" className="text-fg-muted text-xs">
          {t('messages.commentTemporaryDestination')}
        </p>
      ) : null}
      {stagingError ||
      !target.scopeValid ||
      (target.destination && !target.available) ? (
        <p role="alert" className="text-danger text-xs">
          {t('messages.commentDestinationUnavailable')}
        </p>
      ) : null}
    </FragmentCommentPopover>
  );
}
