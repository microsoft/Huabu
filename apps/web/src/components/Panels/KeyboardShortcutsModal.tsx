import { X } from 'lucide-react';

import { keyboardShortcutSections } from '../../config/shortcuts';
import { Button } from '../Common/Button';
import { Modal } from '../Common/Modal';

type KeyboardShortcutsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function KeyboardShortcutsModal({
  isOpen,
  onClose,
}: KeyboardShortcutsModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      className="flex max-h-[calc(100vh-4rem)] w-[42rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
    >
      <div className="border-edge-default flex flex-shrink-0 items-start justify-between border-b px-6 py-5">
        <div>
          <h3 className="text-fg-default text-base font-semibold">
            Keyboard Shortcuts
          </h3>
          <p className="text-fg-muted mt-1.5 text-[13px] leading-relaxed">
            Use{' '}
            <kbd className="bg-surface rounded border px-1 py-0.5 font-mono text-[11px] shadow-sm">
              Ctrl
            </kbd>{' '}
            on Windows/Linux and{' '}
            <kbd className="bg-surface rounded border px-1 py-0.5 font-mono text-[11px] shadow-sm">
              Cmd
            </kbd>{' '}
            on macOS.
          </p>
        </div>
        <Button
          variant="ghost"
          iconOnly
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close keyboard shortcuts"
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
                    <span className="text-fg-muted font-mono text-[11px] font-semibold tracking-wide">
                      {item.keys}
                    </span>
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
