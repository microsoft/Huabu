/**
 * Inline approve/deny card for an external (ACP) agent's
 * `session/request_permission`.
 *
 * The agent's request is suspended server-side until the user answers
 * here; the choice is POSTed via {@link respondAcpPermission} keyed by
 * `requestId`. Once answered (or cancelled) we set `resolution`
 * optimistically so the card collapses to a one-line summary without
 * waiting for any further stream event.
 *
 * Transient by design — permission parts are never persisted, so this
 * card only ever appears live (or briefly after a mid-turn reconnect
 * via the SSE event-buffer replay).
 *
 * Semantic-token discipline (design-system §2.1):
 *   allow options  → tone `info` / `neutral`
 *   reject options → tone `danger`
 */

import { ShieldQuestion } from 'lucide-react';
import { useState } from 'react';

import { respondAcpPermission } from '../../../api/acp';
import { useChatStore } from '../../../store/chatStore';
import { Button } from '../../Common/Button';

import type { AssistantSegment } from '../../../store/chatTypes';
import type {
  AcpPermissionOption,
  AcpPermissionOptionKind,
} from '@sediment/shared';

type PermissionPart = Extract<AssistantSegment, { kind: 'permission' }>;

interface PermissionCardProps {
  /** Thread the request belongs to; reply target. */
  threadId: string;
  /** Assistant message that owns this permission segment. */
  messageId: string;
  part: PermissionPart;
}

/** Reject-orientation options render with the danger tone. */
function isReject(kind: AcpPermissionOptionKind | undefined): boolean {
  return kind === 'reject_once' || kind === 'reject_always';
}

/** Map an option kind to a Button tone (allow → info/neutral, reject → danger). */
function toneForOption(
  kind: AcpPermissionOptionKind | undefined,
): 'info' | 'neutral' | 'danger' {
  if (isReject(kind)) return 'danger';
  if (kind === 'allow_always' || kind === 'allow_once') return 'info';
  return 'neutral';
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
  content: NonNullable<PermissionPart['toolCall']['content']>,
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

export function PermissionCard({
  threadId,
  messageId,
  part,
}: PermissionCardProps) {
  const updateMessage = useChatStore((s) => s.updateMessage);
  const [submitting, setSubmitting] = useState(false);

  const { requestId, toolCall, options, resolution } = part;
  const title = toolCall.title?.trim() || 'Permission requested';

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
    if (submitting || resolution) return;
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

  function applyResolution(next: PermissionPart['resolution']) {
    updateMessage(threadId, messageId, (m) => {
      if (m.role !== 'assistant') return m;
      const idx = m.segments.findIndex(
        (s) => s.kind === 'permission' && s.requestId === requestId,
      );
      if (idx === -1) return m;
      const segs = [...m.segments];
      const seg = segs[idx] as PermissionPart;
      segs[idx] = { ...seg, resolution: next };
      return { ...m, segments: segs };
    });
  }

  if (resolution) {
    const picked = resolution.optionId
      ? options.find((o) => o.optionId === resolution.optionId)
      : undefined;
    const label = resolution.cancelled
      ? 'Cancelled'
      : (picked?.name ?? 'Decided');
    return (
      <div className="flex justify-start">
        <div className="border-edge-default bg-surface text-fg-muted ml-1 flex w-full items-center gap-1.5 rounded-md border px-3 py-2 text-xs">
          <ShieldQuestion size={14} className="text-fg-subtle shrink-0" />
          <span className="text-fg-default font-medium">{title}</span>
          <span aria-hidden>·</span>
          <span>{label}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div
        role="group"
        aria-label="Agent permission request"
        aria-live="polite"
        className="border-edge-default bg-surface ml-1 w-full rounded-md border"
      >
        <div className="flex items-center gap-1.5 px-3 py-2">
          <ShieldQuestion size={14} className="text-info shrink-0" />
          <span className="text-fg-default text-sm font-medium">{title}</span>
        </div>
        {preview && (
          <pre className="border-edge-default text-fg-default bg-bg-default mx-3 mb-2 overflow-x-auto rounded border px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
            {preview}
          </pre>
        )}
        {locations.length > 0 && (
          <div className="text-fg-muted mx-3 mb-2 flex flex-wrap gap-1 text-xs">
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
        <div className="flex flex-wrap gap-2 px-3 pb-3">
          {options.map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              variant={isReject(option.kind) ? 'outline' : 'solid'}
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
