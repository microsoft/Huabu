/**
 * PreparedPromptMessage — renders the structured prompt that the ACP
 * preprocessor produced for an external agent turn.
 *
 * Three states drive the visual:
 *   - **pending**: `prompt === null && !error` — preprocessor is still
 *     running. Shows a small spinner + "Preparing prompt for <alias>…"
 *   - **ready**: `prompt !== null` — collapsed by default, click to
 *     expand and see the `task` body + (optional) `attachments` list.
 *   - **failed**: `prompt === null && error` — small error chip; the
 *     external agent received the raw user text as fallback.
 *
 * Most turns produce a task-only prompt — selected-node content is
 * synthesised inline by the preprocessor. `attachments` only appears
 * when the preprocessor decided verbatim file access was essential
 * (oversize node, `.artifacts/` file, code-review-style ask).
 *
 * Visual shell (icon slot, title row, chevron, expand/collapse) is
 * provided by `AssistantDisclosure` so this card stays visually
 * aligned with its siblings (`ThinkingCard`, `ToolCallCard`).
 */

import { FileText, Loader2 } from 'lucide-react';

import { AssistantDisclosure } from './AssistantDisclosure';

import type { ExternalAgentPrompt } from '@sediment/shared';

interface PreparedPromptMessageProps {
  prompt: ExternalAgentPrompt | null;
  agentAlias: string;
  error?: string;
}

export function PreparedPromptMessage({
  prompt,
  agentAlias,
  error,
}: PreparedPromptMessageProps) {
  // ── pending ──────────────────────────────────────────────────────
  if (prompt === null && !error) {
    return (
      <AssistantDisclosure
        icon={<Loader2 size={12} className="animate-spin" />}
        title={`Preparing prompt for ${agentAlias}…`}
      />
    );
  }

  // ── failed ───────────────────────────────────────────────────────
  if (prompt === null && error) {
    return (
      <AssistantDisclosure
        icon={<FileText size={12} className="text-fg-muted/60" />}
        title={`Prompt preprocessing failed for ${agentAlias} — sent raw message.`}
      />
    );
  }

  // ── ready ────────────────────────────────────────────────────────
  // (Non-null prompt is guaranteed by the two guards above.)
  if (!prompt) return null;

  const attachmentCount = prompt.attachments.length;
  const summary =
    attachmentCount > 0
      ? `Prepared prompt · ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}`
      : 'Prepared prompt';

  return (
    <AssistantDisclosure
      icon={<FileText size={12} className="text-fg-muted/60" />}
      title={`${summary} → ${agentAlias}`}
      bodyClassName="ml-5 space-y-2"
    >
      <div>
        <div className="text-fg-muted/70 mb-0.5 text-[10px] font-medium tracking-wide uppercase">
          Task
        </div>
        <div className="wrap-break-word whitespace-pre-wrap">{prompt.task}</div>
      </div>

      {attachmentCount > 0 && (
        <div>
          <div className="text-fg-muted/70 mb-0.5 text-[10px] font-medium tracking-wide uppercase">
            Attachments
          </div>
          <ul className="space-y-0.5">
            {prompt.attachments.map((ref) => (
              <li
                key={ref.path}
                className="flex items-baseline gap-1.5 leading-snug"
              >
                <code className="bg-surface-1/50 rounded px-1 text-[11px]">
                  {ref.path}
                </code>
                <span className="text-fg-muted/80">— {ref.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </AssistantDisclosure>
  );
}
