// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { X } from 'lucide-react';
import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  formatShortcutById,
  getKeyboardShortcutSections,
} from '../../../config/shortcuts';
import { isMac, shortcutTokens } from '../../../utils/platform';
import { Button } from '../../Common/Button';
import { Modal } from '../../Common/Modal';

type KeyboardShortcutsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function KeyboardShortcutsModal({
  isOpen,
  onClose,
}: KeyboardShortcutsModalProps) {
  const { t } = useTranslation();
  const keyboardShortcutSections = useMemo(
    () => getKeyboardShortcutSections(t),
    [t],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      className="flex max-h-[calc(100vh-4rem)] w-[42rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
    >
      <div className="border-edge-default flex flex-shrink-0 items-start justify-between border-b px-6 py-5">
        <div>
          <h3 className="text-fg-default text-base font-semibold">
            {t('shortcuts.title')}
          </h3>
        </div>
        <Button
          variant="ghost"
          iconOnly
          onClick={onClose}
          title={`${t('actions.close')} (${formatShortcutById('help.close')})`}
          aria-label={t('shortcuts.closeAria')}
        >
          <X />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="space-y-6">
          {keyboardShortcutSections.map((section) => (
            <section key={section.title} className="space-y-3">
              <h4 className="text-fg-muted text-sm font-medium">
                {section.title}
              </h4>
              <div className="border-edge-default bg-surface overflow-hidden rounded-lg border">
                {section.items.map((item, index) => (
                  <div
                    key={`${section.title}-${item.keys}`}
                    className={[
                      'bg-surface/50 grid grid-cols-[minmax(9rem,12rem)_1fr] items-center gap-3 px-4 py-3 text-sm',
                      index !== section.items.length - 1
                        ? 'border-edge-default border-b'
                        : '',
                    ].join(' ')}
                  >
                    <ShortcutKeys template={item.keys} />
                    <span className="text-fg-muted text-[13px]">
                      {item.description}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Render a shortcut template as a row of `<kbd>` chips. Each key gets its
 * own chip so combinations involving the `+` or `−` keys (e.g. `Ctrl+Plus`)
 * are unambiguous. On non-Mac platforms a small `+` glyph is shown between
 * chips to match the native Windows / Linux convention; on macOS the chips
 * sit next to each other, matching how `⌘⇧Z` is conventionally rendered.
 */
function ShortcutKeys({ template }: { template: string }) {
  const tokens = shortcutTokens(template);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tokens.map((token, index) => (
        <Fragment key={`${token}-${index}`}>
          {index > 0 && !isMac && (
            <span
              aria-hidden
              className="text-fg-subtle text-[11px] leading-none"
            >
              +
            </span>
          )}
          <kbd className="border-edge-default bg-bg-default text-fg-default inline-flex min-w-6 items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none font-semibold">
            {token}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}
