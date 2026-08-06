// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button, type Tone } from './Button';
import { cn } from './cn';
import { getElectronBridge } from '../../hooks/useElectron';

import type { ComponentType, SVGProps } from 'react';

/**
 * Toast color family. Re-exports the shared `Tone` vocabulary used by
 * `Button` so a toast's tone maps 1:1 onto an inner button's tone.
 */
export type ToastTone = Tone;

/**
 * Primary action button rendered inline in the toast (e.g. "Reload",
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
   * danger toasts and 3000 for all other tones.
   */
  duration?: number;
  /** Optional inline action button (e.g. Reload / Undo). */
  action?: ToastAction;
  /**
   * Optional second inline action button, rendered before {@link action}.
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

/**
 * Toast surface — soft tinted background (`*-bg`) + 1px border in the
 * full tone color (same hue as the message text / status badge). Pairs
 * a low-saturation fill with a high-saturation outline so the toast
 * reads as a single colour family from across the canvas.
 */
const toneSurfaceClasses: Record<ToastTone, string> = {
  neutral: 'bg-surface border-fg-default',
  info: 'bg-info-bg border-info',
  success: 'bg-success-bg border-success',
  warning: 'bg-warning-bg border-warning',
  danger: 'bg-danger-bg border-danger',
};

/** Message text color per tone — matches the badge so the toast reads
 * as a single color family. Neutral falls back to the default fg. */
const toneTextClasses: Record<ToastTone, string> = {
  neutral: 'text-fg-default',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

/**
 * Status badge — a small solid-colored circle with a white icon. Sits
 * at the left of the toast and is the primary severity signal so the
 * message text can stay neutral.
 */
const toneBadgeClasses: Record<ToastTone, string> = {
  neutral: 'bg-inverse text-fg-inverse',
  info: 'bg-info text-fg-inverse',
  success: 'bg-success text-fg-inverse',
  warning: 'bg-warning text-fg-inverse',
  danger: 'bg-danger text-fg-inverse',
};

/**
 * Per-tone style for the inline action / close buttons. Text uses the
 * full tone color so the buttons read as part of the toast's color
 * scheme; hover uses the existing `*-bg-hover` design tokens (one
 * shade darker than the toast surface) — no opacity math required.
 */
const toneButtonClasses: Record<ToastTone, string> = {
  neutral: 'text-fg-default enabled:hover:bg-hover',
  info: 'text-info enabled:hover:bg-info-bg-hover',
  success: 'text-success enabled:hover:bg-success-bg-hover',
  warning: 'text-warning enabled:hover:bg-warning-bg-hover',
  danger: 'text-danger enabled:hover:bg-danger-bg-hover',
};

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** Status icon rendered inside the badge, keyed by tone. */
const toneIcons: Record<ToastTone, IconComponent> = {
  neutral: Info,
  info: Info,
  success: Check,
  warning: AlertTriangle,
  danger: X,
};

function getToastDuration(item: ToastItem): number {
  return item.duration ?? (item.tone === 'danger' ? 0 : 3000);
}

function ToastEntry({ item }: { item: ToastItem }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const duration = getToastDuration(item);

  useEffect(() => {
    // Trigger enter animation on next frame
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (duration <= 0) return;
    const timer = setTimeout(() => dismissToast(item.id), duration);
    return () => clearTimeout(timer);
  }, [duration, item.id]);

  const isPersistent = duration <= 0;
  // Persistent toasts and action-bearing toasts must always be
  // user-dismissible — they don't fade on their own, and the user may
  // want to act on the message later (e.g. copy unsaved text before
  // reloading) rather than commit immediately.
  const showClose = item.dismissible ?? (isPersistent || !!item.action);
  // Hoist into a local so the click handler closes over a non-null
  // reference (avoids the non-null assertion lint).
  const action = item.action;
  const secondaryAction = item.secondaryAction;
  const tone = item.tone ?? 'info';
  const StatusIcon = toneIcons[tone];
  const buttonClass = toneButtonClasses[tone];

  // A genuine two-way choice (both actions present) gets a stacked
  // layout: message on top, an end-aligned button bar below. A long
  // conflict message would otherwise leave the buttons floating in the
  // vertical centre of the wrapped text. Single-action / info-only
  // toasts keep the compact single-row layout.
  const stacked = !!action && !!secondaryAction;

  const badge = (
    <span
      aria-hidden
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
        toneBadgeClasses[tone],
      )}
    >
      <StatusIcon className="h-3 w-3" strokeWidth={3} />
    </span>
  );

  const secondaryButton = secondaryAction && (
    <Button
      variant="ghost"
      size="sm"
      tone={tone}
      className={buttonClass}
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
      variant="outline"
      size="sm"
      tone={tone}
      className={buttonClass}
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
      size="sm"
      iconOnly
      className={buttonClass}
      aria-label={t('actions.dismiss')}
      onClick={() => dismissToast(item.id)}
    >
      <X />
    </Button>
  );

  return (
    <div
      className={cn(
        'pointer-events-auto flex w-fit max-w-md rounded-xl border px-3 py-2.5 text-sm shadow-lg transition-all duration-200',
        stacked ? 'flex-col gap-2' : 'items-center gap-3',
        visible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0',
        toneSurfaceClasses[tone],
        toneTextClasses[tone],
      )}
      role="status"
    >
      {stacked ? (
        <>
          <div className="flex items-start gap-3">
            {badge}
            <span className="min-w-0 flex-1 py-0.5">{item.message}</span>
            {closeButton}
          </div>
          <div className="flex justify-end gap-2">
            {secondaryButton}
            {actionButton}
          </div>
        </>
      ) : (
        <>
          {badge}
          <span className="min-w-0 flex-1">{item.message}</span>
          {secondaryButton}
          {actionButton}
          {closeButton}
        </>
      )}
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
      className="pointer-events-none fixed left-1/2 z-9999 flex -translate-x-1/2 flex-col items-center gap-2"
      style={{ top: topOffset }}
    >
      {toasts.map((t) => (
        <ToastEntry key={t.id} item={t} />
      ))}
    </div>,
    document.body,
  );
}
