/**
 * `AcpSessionSelectors` — the dropdown "pills" rendered next to the
 * NewChatMenu when the active thread is delegated to an external agent
 * that advertises selectable knobs (mode / model / reasoning level /
 * auto-approve toggle …).
 *
 * This component is presentation only. Which channel a knob arrives on
 * (legacy `availableModes` / `availableModels` vs modern `configOptions`),
 * which of the two wins when an agent publishes both, and whether the value
 * to show is this thread's explicit selection or the agent's own report are
 * all decided by `buildAcpSessionSelectors` in `@sediment/shared` — one
 * normalisation shared with the server. Everything below reads
 * `AcpSessionSelector` and nothing else, so there is no second opinion
 * about the agent's shape to drift out of sync.
 *
 * All `onChange` handlers fire optimistically: the parent records the choice
 * in the snapshot's `selections` map before the server round-trip resolves,
 * so the pill reflects it immediately. A `502` from the agent surfaces as a
 * thrown error the parent reverts by dropping that selection again.
 */

import { TriangleAlert } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildAcpSessionSelectors } from '@sediment/shared';

import { SessionSelectorPill } from './SessionSelectorPill';
import { Button } from '../../Common/Button';
import { Loading } from '../../Common/Loading';
import { Popover } from '../../Common/Popover';

import type { SelectOption } from '../../Common/Select';
import type {
  AcpSessionMetaSnapshot,
  AcpSessionSelector,
} from '@sediment/shared';

/** Mode value that hands the agent unrestricted tool access. */
const FULL_ACCESS_VALUE = 'agent-full-access';

interface AcpSessionSelectorsProps {
  meta: AcpSessionMetaSnapshot;
  /**
   * Whether the parent thread is currently streaming. Selectors stay
   * interactive during a turn (mid-turn mode/model switches are a
   * supported ACP affordance), but consumers may opt into a disabled
   * variant by passing `true` here.
   */
  disabled?: boolean;
  /**
   * True while the initial session-meta fetch is in-flight (covers
   * both the `session/new` round-trip and the late-push retry).
   * Used to swap the empty render for a placeholder pill so the
   * toolbar gives the user feedback that selectors are still on the
   * way instead of looking inert.
   */
  loading?: boolean;
  onSelectMode: (modeId: string) => void | Promise<void>;
  onSelectModel: (modelId: string) => void | Promise<void>;
  onSelectConfigOption: (
    optionId: string,
    value: string | boolean,
  ) => void | Promise<void>;
}

export const AcpSessionSelectors = ({
  meta,
  disabled = false,
  loading = false,
  onSelectMode,
  onSelectModel,
  onSelectConfigOption,
}: AcpSessionSelectorsProps) => {
  const { t } = useTranslation();
  const [pendingFullAccess, setPendingFullAccess] = useState<{
    selector: AcpSessionSelector;
    value: string;
    position: { x: number; y: number };
  } | null>(null);
  const selectorRowRef = useRef<HTMLDivElement>(null);
  const fullAccessOriginRef = useRef<HTMLElement | null>(null);
  const fullAccessTitleId = useId();
  const fullAccessDescriptionId = useId();

  const selectors = useMemo(() => buildAcpSessionSelectors(meta), [meta]);

  const dismissFullAccess = () => {
    setPendingFullAccess(null);
    window.setTimeout(() => fullAccessOriginRef.current?.focus(), 0);
  };

  /**
   * Route a change back through the channel the knob arrived on: the
   * synthesised legacy pills have their own set-RPCs, everything else is a
   * config option.
   */
  const commit = (selector: AcpSessionSelector, value: string | boolean) => {
    if (selector.channel === 'mode') return onSelectMode(String(value));
    if (selector.channel === 'model') return onSelectModel(String(value));
    return onSelectConfigOption(selector.id, value);
  };

  /**
   * Synthesised legacy pills carry no agent-published name, so fall back to
   * a localised label keyed off the semantic category.
   */
  const labelOf = (selector: AcpSessionSelector): string => {
    if (selector.label) return selector.label;
    if (selector.category === 'mode') return t('chat.agentMode');
    if (selector.category === 'model') return t('chat.model');
    return selector.id;
  };

  // Initial fetch in-flight and no data merged yet — show a single
  // unobtrusive placeholder pill so the toolbar signals that the
  // agent's selectors are still loading instead of looking inert.
  // Once any selector is renderable we drop the placeholder, even if
  // a follow-up refresh is still pending, to avoid layout jitter.
  if (selectors.length === 0) {
    if (loading) {
      return (
        <span
          role="status"
          aria-live="polite"
          aria-label={t('chat.loadingAgentOptions')}
          className="text-fg-subtle inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs whitespace-nowrap"
        >
          <Loading layout="inline" size="xs" />
          <span>{t('chat.loadingAgentOptionsProgress')}</span>
        </span>
      );
    }
    return null;
  }

  const booleanOptions: SelectOption<'true' | 'false'>[] = [
    { value: 'true', label: t('chat.on') },
    { value: 'false', label: t('chat.off') },
  ];

  return (
    <>
      <div
        ref={selectorRowRef}
        className="flex min-w-0 shrink items-center overflow-hidden"
      >
        {selectors.map((selector) =>
          selector.kind === 'boolean' ? (
            <SessionSelectorPill<'true' | 'false'>
              key={selector.id}
              options={booleanOptions}
              value={selector.currentValue ? 'true' : 'false'}
              onChange={(next) => void commit(selector, next === 'true')}
              disabled={disabled}
              title={labelOf(selector)}
            />
          ) : (
            <SessionSelectorPill<string>
              key={selector.id}
              options={selector.options}
              value={String(selector.currentValue)}
              onChange={(next) => {
                if (
                  selector.category === 'mode' &&
                  next === FULL_ACCESS_VALUE
                ) {
                  const selectorRow = selectorRowRef.current;
                  const chatInputSurface = selectorRow?.closest(
                    '[data-chat-input-surface]',
                  );
                  const rect = (
                    chatInputSurface ?? selectorRow
                  )?.getBoundingClientRect();
                  fullAccessOriginRef.current =
                    document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : null;
                  setPendingFullAccess({
                    selector,
                    value: next,
                    position: rect
                      ? { x: rect.left, y: rect.top }
                      : { x: window.innerWidth / 2, y: window.innerHeight / 2 },
                  });
                  return;
                }
                void commit(selector, next);
              }}
              disabled={disabled}
              title={labelOf(selector)}
            />
          ),
        )}
      </div>
      {pendingFullAccess && (
        <Popover
          position={pendingFullAccess.position}
          anchor="bottom-left"
          offset={{ x: 0, y: -8 }}
          onDismiss={dismissFullAccess}
          className="w-80 max-w-[calc(100vw-1.5rem)] p-4"
        >
          <div
            role="alertdialog"
            aria-labelledby={fullAccessTitleId}
            aria-describedby={fullAccessDescriptionId}
          >
            <div className="flex items-start gap-2.5">
              <TriangleAlert
                aria-hidden="true"
                className="text-warning mt-0.5 h-4 w-4 shrink-0"
              />
              <div className="min-w-0">
                <h3
                  id={fullAccessTitleId}
                  className="text-fg-default text-sm font-semibold"
                >
                  {t('chat.fullAccessConfirmTitle')}
                </h3>
                <p
                  id={fullAccessDescriptionId}
                  className="text-fg-muted mt-1 text-xs leading-5"
                >
                  {t('chat.fullAccessConfirmDescription')}
                </p>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                autoFocus
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={dismissFullAccess}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                variant="solid"
                tone="danger"
                size="sm"
                onClick={() => {
                  const { selector, value } = pendingFullAccess;
                  setPendingFullAccess(null);
                  void commit(selector, value);
                }}
              >
                {t('chat.enableFullAccess')}
              </Button>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
};
