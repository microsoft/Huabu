// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Quote } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Tooltip } from '@/components/Common/Tooltip';

import type { QuotedComment } from '@huabu/shared';
import type { ReactNode } from 'react';

export function QuotedCommentCard({
  comment,
  action,
  children,
}: {
  comment: QuotedComment;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-quoted-comment
      className="group/quoted-comment bg-hover/50 relative flex w-full max-w-full min-w-0 flex-col gap-1 rounded-lg p-2"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Quote aria-hidden="true" className="text-fg-subtle h-3 w-3 shrink-0" />
        <blockquote className="min-w-0 flex-1">
          <Tooltip
            content={comment.quote}
            interactive
            wrapperClassName="block w-full min-w-0"
            contentClassName="max-h-[min(60dvh,24rem)] max-w-[min(90vw,24rem)] overflow-y-auto overscroll-contain wrap-anywhere whitespace-pre-wrap"
          >
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('messages.fragmentQuotedPassage')}
              className="text-fg-muted focus-visible:ring-info block w-full min-w-0 truncate px-0 py-0 text-left text-xs font-normal focus-visible:ring-1"
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                const tooltipId =
                  event.currentTarget.getAttribute('aria-describedby');
                const tooltip = tooltipId
                  ? event.currentTarget.ownerDocument.getElementById(tooltipId)
                  : null;
                if (!tooltip || tooltip.scrollHeight <= tooltip.clientHeight)
                  return;
                const page = tooltip.clientHeight;
                const amounts: Record<string, number> = {
                  ArrowDown: 16,
                  ArrowUp: -16,
                  PageDown: page,
                  PageUp: -page,
                  Home: -tooltip.scrollHeight,
                  End: tooltip.scrollHeight,
                };
                const amount = amounts[event.key];
                if (amount === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                tooltip.scrollBy({ top: amount });
              }}
            >
              {comment.quote}
            </Button>
          </Tooltip>
        </blockquote>
      </div>
      {action ? (
        <div className="pointer-events-none absolute top-1 right-1 z-10 opacity-0 transition-opacity group-focus-within/quoted-comment:pointer-events-auto group-focus-within/quoted-comment:opacity-100 group-hover/quoted-comment:pointer-events-auto group-hover/quoted-comment:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          {action}
        </div>
      ) : null}
      {children ?? (
        <p className="text-fg-default text-sm wrap-anywhere whitespace-pre-wrap">
          {comment.comment}
        </p>
      )}
    </div>
  );
}
