// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** ACP permission history record + the single actionable composer tray. */

import { ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { respondAcpPermission } from '../../../api/acp';
import { useChatStore } from '../../../store/chatStore';
import { Button } from '../../Common/Button';
import { CommandBlock } from '../../Common/CommandBlock';
import { AssistantDisclosure } from '../AssistantDisclosure';

import type { PermissionSegment } from '../../../store/chatTypes';
import type {
  AcpPermissionOption,
  AcpPermissionOptionKind,
} from '@huabu/shared';

interface PermissionCardProps {
  part: PermissionSegment;
}

interface PermissionTrayProps {
  threadId: string;
  messageId: string;
  part: PermissionSegment;
}

/** Reject-orientation options render with the danger tone. */
function isReject(kind: AcpPermissionOptionKind | undefined): boolean {
  return kind === 'reject_once' || kind === 'reject_always';
}

/** Map an option kind to a Button tone (allow → warning, reject → danger). */
function toneForOption(
  kind: AcpPermissionOptionKind | undefined,
): 'warning' | 'neutral' | 'danger' {
  if (isReject(kind)) return 'danger';
  if (kind === 'allow_always' || kind === 'allow_once') return 'warning';
  return 'neutral';
}

function variantForOption(
  kind: AcpPermissionOptionKind | undefined,
): 'solid' | 'outline' {
  return kind === 'allow_once' ? 'solid' : 'outline';
}

/**
 * Pull a short, human-readable command/argument string out of
 * `toolCall.rawInput`. Agents are inconsistent about the shape — shell
 * tools usually expose `{ command }` (sometimes with `args[]`), file
 * tools may use `{ path, content }`, others give arbitrary JSON. We
 * pick the most useful single string, falling back to a compact JSON
 * dump so the user always sees *something* concrete.
 *
 * Returns `null` when there is nothing meaningful to show (e.g. empty
 * object or non-object primitives that are already redundant with the
 * card title).
 */
function previewFromRawInput(rawInput: unknown): string | null {
  if (rawInput === null || rawInput === undefined) return null;
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof rawInput !== 'object') return String(rawInput);

  const obj = rawInput as Record<string, unknown>;
  // Common shell-tool shapes first.
  if (typeof obj.command === 'string' && obj.command.trim().length > 0) {
    const args = Array.isArray(obj.args)
      ? obj.args.filter((a): a is string => typeof a === 'string').join(' ')
      : '';
    return args ? `${obj.command} ${args}` : obj.command;
  }
  if (typeof obj.cmd === 'string' && obj.cmd.trim().length > 0) {
    return obj.cmd;
  }
  // Generic fall-back: stringify, but keep it short.
  try {
    const json = JSON.stringify(obj);
    return json.length > 600 ? `${json.slice(0, 600)}…` : json;
  } catch {
    return null;
  }
}

/** Extract a flat preview text from ACP `toolCall.content` blocks. */
function previewFromContent(
  content: NonNullable<PermissionSegment['toolCall']['content']>,
): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'content') {
      const inner = block as unknown as { content?: { text?: unknown } };
      const text = inner.content?.text;
      if (typeof text === 'string' && text.trim().length > 0) parts.push(text);
    } else if (block.type === 'diff') {
      const d = block as unknown as { newText?: unknown; path?: unknown };
      if (typeof d.path === 'string') parts.push(`diff: ${d.path}`);
    } else if (block.type === 'terminal') {
      const t = block as unknown as { command?: unknown };
      if (typeof t.command === 'string') parts.push(t.command);
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join('\n');
  return joined.length > 800 ? `${joined.slice(0, 800)}…` : joined;
}

function permissionTitle(part: PermissionSegment, fallback: string): string {
  return part.toolCall.title?.trim() || fallback;
}

function resolutionLabel(
  part: PermissionSegment,
  cancelledLabel: string,
  decidedLabel: string,
): string | null {
  if (!part.resolution) return null;
  const picked = part.resolution.optionId
    ? part.options.find(
        (option) => option.optionId === part.resolution?.optionId,
      )
    : undefined;
  return part.resolution.cancelled
    ? cancelledLabel
    : (picked?.name ?? decidedLabel);
}

export function PermissionCard({ part }: PermissionCardProps) {
  const { t } = useTranslation();
  const title = permissionTitle(part, t('messages.permissionRequested'));
  // Only a resolved/cancelled request contributes a trailing status. While
  // pending, the amber icon already signals the state and the composer tray
  // owns the action, so we skip the label to avoid repeating it after the
  // (possibly identical) fallback title.
  const outcome = resolutionLabel(
    part,
    t('messages.cancelled'),
    t('messages.decided'),
  );

  return (
    <AssistantDisclosure
      icon={
        <ShieldQuestion
          size={12}
          className={part.resolution ? 'text-fg-subtle' : 'text-warning'}
        />
      }
      title={
        <>
          <span className="text-fg-default font-medium">{title}</span>
          {outcome ? (
            <>
              <span className="mx-1.5" aria-hidden>
                ·
              </span>
              <span>{outcome}</span>
            </>
          ) : null}
        </>
      }
    />
  );
}

export function PermissionTray({
  threadId,
  messageId,
  part,
}: PermissionTrayProps) {
  const { t } = useTranslation();
  const updateMessage = useChatStore((state) => state.updateMessage);
  const [submitting, setSubmitting] = useState(false);

  const { requestId, toolCall, options } = part;
  const title = permissionTitle(part, t('messages.permissionRequested'));

  // Pick the most informative preview: rich `content` first (the agent
  // explicitly composed it for display), then `rawInput` (structured
  // tool args). `locations` is shown alongside as a file-list footer.
  const contentPreview = toolCall.content
    ? previewFromContent(toolCall.content)
    : null;
  const inputPreview = contentPreview
    ? null
    : previewFromRawInput(toolCall.rawInput);
  const preview = contentPreview ?? inputPreview;
  const locations = (toolCall.locations ?? [])
    .map((l) => (typeof l?.path === 'string' ? l.path : null))
    .filter((p): p is string => !!p);

  const resolve = async (option?: AcpPermissionOption) => {
    if (submitting || part.resolution) return;
    setSubmitting(true);
    // Optimistic local resolution before the network round-trip.
    applyResolution(
      option ? { optionId: option.optionId } : { cancelled: true },
    );
    try {
      await respondAcpPermission(threadId, {
        requestId,
        ...(option ? { optionId: option.optionId } : { cancelled: true }),
      });
    } catch {
      // The server is the source of truth for the suspended promise;
      // a failed POST means the agent keeps waiting (until timeout).
      // Roll back so the user can retry.
      applyResolution(undefined);
    } finally {
      setSubmitting(false);
    }
  };

  function applyResolution(next: PermissionSegment['resolution']) {
    updateMessage(threadId, messageId, (m) => {
      if (m.role !== 'assistant') return m;
      const idx = m.segments.findIndex(
        (s) => s.kind === 'permission' && s.requestId === requestId,
      );
      if (idx === -1) return m;
      const segs = [...m.segments];
      const seg = segs[idx] as PermissionSegment;
      segs[idx] = { ...seg, resolution: next };
      return { ...m, segments: segs };
    });
  }

  return (
    <div
      role="group"
      aria-label={t('messages.permissionRequestAria')}
      aria-live="polite"
      className="border-edge-default bg-surface rounded-xl border"
    >
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="bg-warning-bg text-warning flex size-6 shrink-0 items-center justify-center rounded-full">
            <ShieldQuestion size={14} />
          </span>
          <span className="text-fg-default text-sm font-medium">{title}</span>
        </div>
        {preview && (
          <CommandBlock
            text={preview}
            className="bg-warning-bg/45 [&_pre>span]:text-warning mt-2 border-transparent"
          />
        )}
        {locations.length > 0 && (
          <div className="text-fg-muted mt-2 flex flex-wrap gap-1 text-xs">
            {locations.map((p) => (
              <span
                key={p}
                className="bg-bg-default border-edge-default rounded border px-1.5 py-0.5 font-mono"
              >
                {p}
              </span>
            ))}
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              variant={variantForOption(option.kind)}
              tone={toneForOption(option.kind)}
              disabled={submitting}
              onClick={() => void resolve(option)}
            >
              {option.name}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
