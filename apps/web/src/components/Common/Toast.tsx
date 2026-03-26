import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from './cn';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastItem {
  id: string;
  message: string;
  variant?: ToastVariant;
  /** Auto-dismiss duration in ms. Set 0 to persist. Defaults to 3000. */
  duration?: number;
}

// ─── Global toast state ────────────────────────────────────────────────
let _listeners: Array<() => void> = [];
let _toasts: ToastItem[] = [];

function emit() {
  _listeners.forEach((l) => l());
}

let _nextId = 0;

/**
 * Show a toast notification.
 * Returns the toast id (useful for manual dismissal).
 */
export function toast(
  message: string,
  opts?: { variant?: ToastVariant; duration?: number },
): string {
  const id = `toast-${++_nextId}`;
  _toasts = [..._toasts, { id, message, ...opts }];
  emit();
  return id;
}

/** Dismiss a single toast by id. */
export function dismissToast(id: string) {
  _toasts = _toasts.filter((t) => t.id !== id);
  emit();
}

// ─── React component ──────────────────────────────────────────────────

const variantClasses: Record<ToastVariant, string> = {
  info: 'bg-surface-invert text-surface-invert-foreground',
  success: 'bg-surface-invert text-surface-invert-foreground',
  error: 'bg-danger text-surface-invert-foreground',
};

function ToastEntry({ item }: { item: ToastItem }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation on next frame
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const ms = item.duration ?? 3000;
    if (ms <= 0) return;
    const timer = setTimeout(() => dismissToast(item.id), ms);
    return () => clearTimeout(timer);
  }, [item.id, item.duration]);

  return (
    <div
      className={cn(
        'pointer-events-auto w-fit max-w-sm rounded-lg px-4 py-2 text-sm shadow-lg transition-all duration-200',
        visible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0',
        variantClasses[item.variant ?? 'info'],
      )}
      role="status"
    >
      {item.message}
    </div>
  );
}

/**
 * Renders all active toasts. Mount once near the app root.
 */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener = () => setToasts([..._toasts]);
    _listeners.push(listener);
    // Sync initial state
    listener();
    return () => {
      _listeners = _listeners.filter((l) => l !== listener);
    };
  }, []);

  if (toasts.length === 0) return null;

  return createPortal(
    <div className="pointer-events-none fixed top-6 left-1/2 z-[9999] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <ToastEntry key={t.id} item={t} />
      ))}
    </div>,
    document.body,
  );
}
