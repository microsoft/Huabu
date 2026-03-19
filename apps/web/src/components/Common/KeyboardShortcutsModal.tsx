import { X } from 'lucide-react';

import { IconButton } from './IconButton';
import { Modal } from './Modal';
import { keyboardShortcutSections } from '../../config/shortcuts';

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
      title="Keyboard Shortcuts"
      description="Use Ctrl on Windows/Linux and Cmd on macOS."
      className="flex max-h-[calc(100vh-4rem)] w-[42rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
    >
      <div className="flex flex-shrink-0 items-start justify-between border-b border-gray-100 px-6 py-5">
        <div>
          <h3 className="text-base font-semibold text-gray-800">
            Keyboard Shortcuts
          </h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-gray-500">
            Use{' '}
            <kbd className="rounded border bg-gray-50 px-1 py-0.5 font-mono text-[11px] shadow-sm">
              Ctrl
            </kbd>{' '}
            on Windows/Linux and{' '}
            <kbd className="rounded border bg-gray-50 px-1 py-0.5 font-mono text-[11px] shadow-sm">
              Cmd
            </kbd>{' '}
            on macOS.
          </p>
        </div>
        <IconButton
          variant="ghost"
          onClick={onClose}
          className="-mt-1 -mr-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          title="Close (Esc)"
          aria-label="Close keyboard shortcuts"
        >
          <X size={18} />
        </IconButton>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="space-y-6">
          {keyboardShortcutSections.map((section) => (
            <section key={section.title} className="space-y-3">
              <h4 className="text-sm font-medium text-gray-700">
                {section.title}
              </h4>
              <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                {section.items.map((item, index) => (
                  <div
                    key={`${section.title}-${item.keys}`}
                    className={[
                      'grid grid-cols-[minmax(9rem,12rem)_1fr] items-center gap-3 bg-gray-50/50 px-4 py-3 text-sm',
                      index !== section.items.length - 1
                        ? 'border-b border-gray-200'
                        : '',
                    ].join(' ')}
                  >
                    <span className="font-mono text-[11px] font-semibold tracking-wide text-gray-600">
                      {item.keys}
                    </span>
                    <span className="text-[13px] text-gray-500">
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
