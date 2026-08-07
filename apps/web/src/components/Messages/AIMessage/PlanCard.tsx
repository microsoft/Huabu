// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Display an ACP plan (`AcpPlanEntry[]`) as a checklist card.
 *
 * Plans use REPLACE-semantics per ACP §session/update — each `plan`
 * event carries the full current entry list, so this component just
 * renders the latest array it receives. A "Copy plan" button in the
 * header serializes the entries as a markdown checklist for easy
 * paste-into-docs.
 *
 * Semantic-token discipline (matches design-system §2.1):
 *   pending     → text-fg-muted   (no special color)
 *   in_progress → text-info       (active)
 *   completed   → text-success    (done)
 *   priority badge uses tonal pills, no raw hex.
 */

import { Check, ChevronRight, Circle, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { copyToClipboard } from '../../../utils/io/clipboard';
import { Button } from '../../Common/Button';
import { Loading } from '../../Common/Loading';

import type { AcpPlanEntry } from '@huabu/shared';

interface PlanCardProps {
  entries: AcpPlanEntry[];
}

/** Serialize plan entries as a GitHub-flavoured markdown checklist. */
function toMarkdownChecklist(entries: AcpPlanEntry[]): string {
  return entries
    .map((e) => {
      const box =
        e.status === 'completed'
          ? '[x]'
          : e.status === 'in_progress'
            ? '[~]'
            : '[ ]';
      return `- ${box} ${e.content}`;
    })
    .join('\n');
}

export function PlanCard({ entries }: PlanCardProps) {
  const { t } = useTranslation();
  const [isCollapsed, setIsCollapsed] = useState(false);

  if (entries.length === 0) return null;

  const completed = entries.filter((e) => e.status === 'completed').length;
  const total = entries.length;
  const inProgress = entries.some((e) => e.status === 'in_progress');

  return (
    <div className="flex justify-start">
      <div className="border-edge-default bg-surface ml-1 w-full rounded-md border">
        {/* Header */}
        <div className="flex items-center gap-1.5 px-3 py-2">
          <button
            type="button"
            onClick={() => setIsCollapsed((v) => !v)}
            className="text-fg-default hover:text-fg-default flex flex-1 items-center gap-1.5 text-left text-xs"
          >
            <ChevronRight
              size={12}
              className={`text-fg-muted shrink-0 transition-transform ${
                !isCollapsed ? 'rotate-90' : ''
              }`}
            />
            <span className="font-medium">{t('messages.plan')}</span>
            <span className="text-fg-muted">
              · {completed}/{total}
            </span>
          </button>
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            className="text-fg-subtle"
            aria-label={t('messages.copyPlan')}
            title={t('messages.copyPlanMarkdown')}
            onClick={() => copyToClipboard(toMarkdownChecklist(entries))}
          >
            <Copy />
          </Button>
        </div>

        {/* Entries */}
        {!isCollapsed && (
          <ul className="border-edge-default/40 border-t px-3 py-2">
            {entries.map((entry, idx) => (
              <li
                key={idx}
                className="flex items-start gap-2 py-1 text-xs leading-relaxed"
              >
                <span className="mt-0.5 shrink-0">
                  {entry.status === 'completed' ? (
                    <Check size={12} className="text-success" />
                  ) : entry.status === 'in_progress' ? (
                    <Loading layout="inline" size="xs" className="text-info" />
                  ) : (
                    <Circle size={12} className="text-fg-muted" />
                  )}
                </span>
                <span
                  className={
                    entry.status === 'completed'
                      ? 'text-fg-muted line-through'
                      : entry.status === 'in_progress'
                        ? 'text-fg-default'
                        : 'text-fg-default'
                  }
                >
                  {entry.content}
                </span>
                {entry.priority && entry.priority !== 'medium' && (
                  <span
                    className={`text-fg-subtle bg-bg-default ml-auto rounded-full px-1.5 py-0.5 text-[10px] ${
                      entry.priority === 'high'
                        ? 'text-warning'
                        : 'text-fg-subtle'
                    }`}
                  >
                    {entry.priority}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Subtle hint that the plan is mid-execution */}
        {inProgress && (
          <div className="border-edge-default/40 text-fg-subtle border-t px-3 py-1 text-[10px]">
            {t('messages.planInProgress')}
          </div>
        )}
      </div>
    </div>
  );
}
