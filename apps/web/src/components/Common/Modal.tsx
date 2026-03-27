import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from './cn';

export type ModalProps = {
  isOpen: boolean;
  title?: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;

  /**
   * When provided, focus is moved here on open.
   * Useful for defaulting focus to the primary action.
   */
  initialFocusRef?: RefObject<HTMLElement>;

  /** Whether clicking the backdrop closes the modal. Defaults to `true`. */
  closeOnBackdropClick?: boolean;

  /** Whether pressing Escape closes the modal. Defaults to `true`. */
  closeOnEscape?: boolean;

  /** Extra className(s) merged onto the dialog panel. */
  className?: string;

  /** Portal target. Defaults to `document.body`. */
  container?: Element;

  /** CSS z-index for the overlay container. Defaults to `9999`. */
  zIndex?: number;
};

export function Modal({
  isOpen,
  title,
  description,
  children,
  footer,
  onClose,
  initialFocusRef,
  closeOnBackdropClick = true,
  closeOnEscape = true,
  className,
  container,
  zIndex = 9999,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const labelledBy = useMemo(
    () => (title ? titleId : undefined),
    [title, titleId],
  );
  const describedBy = useMemo(
    () => (description ? descriptionId : undefined),
    [description, descriptionId],
  );

  // Lock scroll + focus management
  useEffect(() => {
    if (!isOpen) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const timer = window.setTimeout(() => {
      const target = initialFocusRef?.current;
      if (target) {
        target.focus();
      } else {
        dialogRef.current?.focus();
      }
    }, 0);

    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = originalOverflow;
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    };
  }, [isOpen, initialFocusRef]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, closeOnEscape, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="bg-bg-default/80 animate-in fade-in fixed inset-0 flex items-center justify-center backdrop-blur-[1px] duration-200"
      style={{ zIndex }}
    >
      <div
        className="absolute inset-0"
        onClick={closeOnBackdropClick ? onClose : undefined}
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cn(
          'border-edge-default shadow-bottom animate-in zoom-in-95 bg-surface relative z-10 w-96 max-w-[calc(100vw-3rem)] rounded-lg border p-6 duration-200',
          className,
        )}
      >
        {(title || description) && (
          <div className="mb-2">
            {title && (
              <h3
                id={titleId}
                className="text-fg-default text-md font-semibold"
              >
                {title}
              </h3>
            )}
            {description && (
              <div
                id={descriptionId}
                className={cn('text-fg-muted mt-1 text-sm', !title && 'mt-0')}
              >
                {description}
              </div>
            )}
          </div>
        )}

        {children}

        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    container ?? document.body,
  );
}
