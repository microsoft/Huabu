// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AlertTriangle, CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button, type Tone } from './Button';
import { cn } from './cn';
import { getElectronBridge } from '../../hooks/useElectron';

import './scrollbar.css';

import type { ComponentType, SVGProps } from 'react';

/**
 * Toast color family. Re-exports the shared `Tone` vocabulary used by
 * `Button` so a toast's tone maps 1:1 onto an inner button's tone.
 */
export type ToastTone = Tone;

/**
 * Primary action button rendered beside or below the message (e.g. "Reload",
 * "Undo"). Pair with `duration: 0` to keep the toast visible until the
 * user explicitly acts. The toast auto-dismisses once the handler runs.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  message: string;
  tone?: ToastTone;
  /**
   * Auto-dismiss duration in ms. Set 0 to persist. Defaults to 0 for
   * danger toasts and 3000 for all other tones. Pauses while hovered or
   * focus is inside the toast, then resumes with the remaining time.
   */
  duration?: number;
  /** Optional action button (e.g. Reload / Undo). */
  action?: ToastAction;
  /**
   * Optional second action button, rendered before {@link action}.
   * Used when a message needs a genuine two-way choice (e.g. a content
   * conflict: "Keep mine" vs "Load latest").
   */
  secondaryAction?: ToastAction;
  /**
   * Whether to render a × close button. Defaults to true whenever the
   * toast is persistent (`duration <= 0`) or carries an action — those
   * cases must always be user-dismissible. Auto-dismissing info toasts
   * stay clean (no × needed).
   */
  dismissible?: boolean;
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
  opts?: {
    tone?: ToastTone;
    duration?: number;
    action?: ToastAction;
    secondaryAction?: ToastAction;
    dismissible?: boolean;
  },
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

/** Color stays on the status icon so messages and controls remain neutral. */
const toneIconClasses: Record<ToastTone, string> = {
  neutral: 'text-fg-muted',
  info: 'text-info-fg',
  success: 'text-success-fg',
  warning: 'text-warning-fg',
  danger: 'text-danger-fg',
};

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** Status icon keyed by tone. */
const toneIcons: Record<ToastTone, IconComponent> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: AlertTriangle,
  danger: CircleX,
};

function getToastDuration(item: ToastItem): number {
  return item.duration ?? (item.tone === 'danger' ? 0 : 3000);
}

function ToastEntry({ item }: { item: ToastItem }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const duration = getToastDuration(item);
  const remaining = useRef(duration);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  useEffect(() => {
    // Trigger enter animation on next frame
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (duration <= 0 || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismissToast(item.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - started),
      );
    };
  }, [duration, item.id, paused]);

  const isPersistent = duration <= 0;
  // Persistent toasts and action-bearing toasts must always be
  // user-dismissible — they don't fade on their own, and the user may
  // want to act on the message later (e.g. copy unsaved text before
  // reloading) rather than commit immediately.
  const showClose =
    item.dismissible ??
    (isPersistent || !!item.action || !!item.secondaryAction);
  // Hoist into a local so the click handler closes over a non-null
  // reference (avoids the non-null assertion lint).
  const action = item.action;
  const secondaryAction = item.secondaryAction;
  const tone = item.tone ?? 'info';
  const StatusIcon = toneIcons[tone];
  const buttonClass =
    'shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info';

  const pairedActions = !!action && !!secondaryAction;
  const actionClass = cn(
    buttonClass,
    'min-h-7 max-w-full px-2 text-[13px] leading-5 font-medium [overflow-wrap:anywhere]',
    pairedActions
      ? 'rounded-md'
      : 'mb-2 ml-3 inline-flex max-w-[calc(100%-0.75rem)] align-top',
  );

  const statusIcon = (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center',
        toneIconClasses[tone],
      )}
    >
      <StatusIcon className="h-4.5 w-4.5" />
    </span>
  );

  const secondaryButton = secondaryAction && (
    <Button
      variant="ghost"
      size="sm"
      className={actionClass}
      onClick={() => {
        secondaryAction.onClick();
        dismissToast(item.id);
      }}
    >
      {secondaryAction.label}
    </Button>
  );

  const actionButton = action && (
    <Button
      variant="ghost"
      tone="info"
      size="sm"
      className={actionClass}
      onClick={() => {
        action.onClick();
        dismissToast(item.id);
      }}
    >
      {action.label}
    </Button>
  );

  const closeButton = showClose && (
    <Button
      variant="ghost"
      shape="pill"
      size="sm"
      iconOnly
      className={cn(
        buttonClass,
        'text-fg-subtle enabled:hover:text-fg-default focus-visible:bg-hover absolute top-2.5 right-3 h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5',
      )}
      aria-label={t('actions.dismiss')}
      onClick={() => dismissToast(item.id)}
    >
      <X />
    </Button>
  );

  return (
    <div
      className={cn(
        'border-edge-default bg-surface text-fg-default pointer-events-auto relative flex w-fit max-w-full shrink-0 flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm leading-5 shadow-xs transition-[transform,opacity] duration-200 motion-reduce:transform-none motion-reduce:transition-none',
        !showClose && 'pr-5',
        visible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0',
      )}
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
    >
      <div className="flex min-h-7 min-w-0 items-start gap-2">
        {statusIcon}
        <div className="-mb-2 flow-root min-w-0 flex-1 text-right leading-none">
          {/* Reserve dismiss space on the first line only, not beside wrapped actions. */}
          {showClose && <span aria-hidden className="float-right h-7 w-10" />}
          <span
            className={cn(
              'mb-2 inline-block w-max max-w-full pt-1 text-left align-top leading-5 [overflow-wrap:anywhere]',
              showClose && 'max-w-[calc(100%-2.5rem)]',
            )}
          >
            {item.message}
          </span>
          {!pairedActions && (actionButton || secondaryButton)}
        </div>
      </div>
      {pairedActions && (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 pl-8">
          {secondaryButton}
          {actionButton}
        </div>
      )}
      {closeButton}
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

  // In the Electron shell the OS / `WindowChrome` paints a draggable
  // title bar at the top of the window. Push the toast stack below it
  // so notifications don't overlap the canvas title / settings menu.
  // In a plain browser there is no such chrome, so a small 24px offset
  // from the viewport edge is enough.
  const bridge = getElectronBridge();
  const topOffset = bridge ? bridge.titleBarHeight + 8 : 24;

  return createPortal(
    <div
      className="huabu-scrollbar pointer-events-auto fixed left-1/2 z-9999 flex w-max max-w-[min(28.5rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col items-center gap-2 overflow-y-auto overscroll-contain p-1"
      style={{
        top: topOffset - 4,
        maxHeight: `calc(100dvh - ${topOffset + 12}px)`,
      }}
    >
      {toasts.map((t) => (
        <ToastEntry key={t.id} item={t} />
      ))}
    </div>,
    document.body,
  );
}
