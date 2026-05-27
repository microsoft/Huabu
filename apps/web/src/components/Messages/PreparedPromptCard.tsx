/**
 * PreparedPromptCard — renders the structured prompt that the ACP
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
 * Visual scaffold mirrors `CanvasCommandCard` in `ToolMessage.tsx`
 * (chevron + collapsible body, muted typography) so PR D feels native
 * inside the existing tool-style message list.
 */

import { ChevronRight, FileText, Loader2 } from 'lucide-react';
import { useState } from 'react';

import type { ExternalAgentPrompt } from '@sediment/shared';

interface PreparedPromptCardProps {
  prompt: ExternalAgentPrompt | null;
  agentAlias: string;
  error?: string;
}

export function PreparedPromptCard({
  prompt,
  agentAlias,
  error,
}: PreparedPromptCardProps) {
  // Default to collapsed on ready state to match the "fold by default"
  // rule from the design discussion — the prompt body can be long and
  // most of the time the user just wants to confirm preprocessing ran.
  const [isCollapsed, setIsCollapsed] = useState(true);

  // ── pending ──────────────────────────────────────────────────────
  if (prompt === null && !error) {
    return (
      <div className="flex justify-start">
        <div className="text-fg-muted flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs">
          <Loader2 size={12} className="animate-spin" />
          <span>Preparing prompt for {agentAlias}…</span>
        </div>
      </div>
    );
  }

  // ── failed ───────────────────────────────────────────────────────
  if (prompt === null && error) {
    return (
      <div className="flex justify-start">
        <div className="text-fg-muted/80 flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs">
          <FileText size={12} className="flex-shrink-0" />
          <span>
            Prompt preprocessing failed for {agentAlias} — sent raw message.
          </span>
        </div>
      </div>
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
    <div className="flex justify-start">
      <div className="w-full">
        {/* Header */}
        <div className="text-fg-muted hover:bg-hover flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors">
          <FileText size={12} className="text-fg-muted/60 flex-shrink-0" />
          <button
            type="button"
            onClick={() => setIsCollapsed((prev) => !prev)}
            className="flex flex-1 items-center gap-1 truncate text-left"
          >
            <span>
              {summary} → {agentAlias}
            </span>
            <ChevronRight
              size={10}
              className={`text-fg-muted/50 flex-shrink-0 transition-transform ${
                !isCollapsed ? 'rotate-90' : ''
              }`}
            />
          </button>
        </div>

        {/* Body */}
        {!isCollapsed && (
          <div className="text-fg-muted mt-1 ml-5 space-y-2 text-xs">
            <div>
              <div className="text-fg-muted/70 mb-0.5 text-[10px] font-medium tracking-wide uppercase">
                Task
              </div>
              <div className="break-words whitespace-pre-wrap">
                {prompt.task}
              </div>
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
          </div>
        )}
      </div>
    </div>
  );
}
