/**
 * StatusBadge — pill-shaped status indicator used to annotate canvas nodes
 * and overlays (currently QuestionNode and the sketch processing
 * overlay).
 *
 * Behavior
 *  - Zoom-invariant: lives in React Flow's flow space but counter-scales
 *    `1 / zoom` so its on-screen size + offset stay constant at every
 *    viewport zoom level. This matches the preferred behavior originally
 *    implemented in `SketchProcessingOverlay`.
 *  - Status drives icon, label and colors via the canvas semantic tokens
 *    (`--success`, `--warning`, `--info`, `--danger`, `--fg-subtle`).
 *  - Optional `trailing` slot renders adjacent content (e.g. accept /
 *    revert / preview action buttons) inside the same anchored, scaled
 *    row.
 *
 * The component must be rendered inside a React Flow context (i.e. inside
 * a node body or a `ViewportPortal`) — it relies on `useStore` to read the
 * current zoom transform.
 */

import { useStore } from '@xyflow/react';
import { Check, Clock, Loader, Pencil, X } from 'lucide-react';

import { cn } from './cn';
import { Tooltip } from './Tooltip';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type StatusBadgeStatus =
  | 'preparing'
  | 'pending'
  | 'running'
  | 'done'
  | 'error';

interface StatusVisual {
  icon: LucideIcon;
  defaultLabel: string;
  iconBg: string;
  pillBg: string;
  pillFg: string;
  spin?: boolean;
}

// Single visual identity — both QuestionNode and the sketch overlay
// render at exactly these dimensions, then counter-scale so the on-screen
// size stays constant at every zoom level.
const ICON_BOX_PX = 20;
const ICON_PX = 12;

const STATUS_VISUALS: Record<StatusBadgeStatus, StatusVisual> = {
  preparing: {
    icon: Pencil,
    defaultLabel: 'Preparing',
    iconBg: 'var(--fg-subtle)',
    pillBg: 'color-mix(in srgb, var(--fg-subtle) 10%, white 20%)',
    pillFg: 'var(--fg-subtle)',
  },
  pending: {
    icon: Clock,
    defaultLabel: 'Pending',
    iconBg: 'var(--warning)',
    pillBg: 'color-mix(in srgb, var(--warning) 10%, white 20%)',
    pillFg: 'var(--warning)',
  },
  running: {
    icon: Loader,
    defaultLabel: 'Running',
    iconBg: 'var(--info)',
    pillBg: 'color-mix(in srgb, var(--info) 10%, white 20%)',
    pillFg: 'var(--info)',
    spin: true,
  },
  done: {
    icon: Check,
    defaultLabel: 'Done',
    iconBg: 'var(--success)',
    pillBg: 'color-mix(in srgb, var(--success) 10%, white 20%)',
    pillFg: 'var(--success)',
  },
  error: {
    icon: X,
    defaultLabel: 'Error',
    iconBg: 'var(--danger)',
    pillBg: 'color-mix(in srgb, var(--danger) 10%, white 20%)',
    pillFg: 'var(--danger)',
  },
};

export interface StatusBadgeProps {
  /** Drives icon, default label and color tokens. */
  status: StatusBadgeStatus;
  /** Override the default label for the chosen status. */
  label?: string;
  /**
   * Anchored offset of the badge's top-left corner relative to its parent,
   * expressed in *screen pixels* at 100% zoom. The component multiplies by
   * `1 / zoom` internally so the on-screen offset stays constant.
   */
  offset?: { top?: number; left?: number; right?: number; bottom?: number };
  /** Apply a one-shot shake animation (used for transient error states). */
  shake?: boolean;
  /** Wrap the pill in a `<Tooltip>` with this content. */
  tooltip?: ReactNode;
  /** Render the pill as a `<button>` with this click handler. */
  onClick?: () => void;
  /** Native `title` attribute when rendered as a button. */
  title?: string;
  /**
   * Optional content rendered inline next to the badge (inside the same
   * anchored, zoom-invariant row). Useful for action bars.
   */
  trailing?: ReactNode;
  /** Additional class names applied to the pill. */
  className?: string;
}

export function StatusBadge({
  status,
  label,
  offset,
  shake,
  tooltip,
  onClick,
  title,
  trailing,
  className,
}: StatusBadgeProps) {
  // Counter-scale so the badge's on-screen size stays constant while the
  // canvas zooms. Falls back to 1 if the transform is not yet available.
  const zoom = useStore((s) => s.transform[2]);
  const inverseZoom = zoom > 0 ? 1 / zoom : 1;

  const visual = STATUS_VISUALS[status];
  const Icon = visual.icon;
  const text = label ?? visual.defaultLabel;

  const interactive = typeof onClick === 'function';
  const PillTag = interactive ? 'button' : 'div';

  const pill = (
    <PillTag
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      title={interactive ? title : undefined}
      className={cn(
        'flex items-center gap-1 rounded-full py-0.5 pr-2 pl-0.5 whitespace-nowrap shadow-sm',
        interactive && 'pointer-events-auto cursor-pointer',
        className,
      )}
      style={{
        backgroundColor: visual.pillBg,
        color: visual.pillFg,
        ...(shake && {
          animation: 'question-badge-shake 0.5s ease-in-out',
        }),
      }}
    >
      <span
        className="flex items-center justify-center rounded-full"
        style={{
          width: ICON_BOX_PX,
          height: ICON_BOX_PX,
          backgroundColor: visual.iconBg,
        }}
      >
        <Icon
          size={ICON_PX}
          color="white"
          style={
            visual.spin
              ? { animation: 'question-icon-spin 4s linear infinite' }
              : undefined
          }
        />
      </span>
      <span className="text-xs font-semibold">{text}</span>
    </PillTag>
  );

  const wrapped = tooltip ? <Tooltip content={tooltip}>{pill}</Tooltip> : pill;

  // Position + counter-scale wrapper. `pointer-events-none` keeps the wrapper
  // transparent to mouse input; the inner pill (and any trailing content)
  // re-enables `pointer-events-auto` when interactive.
  return (
    <div
      className="pointer-events-none absolute z-10 flex items-center gap-1"
      style={{
        top: offset?.top !== undefined ? offset.top * inverseZoom : undefined,
        left:
          offset?.left !== undefined ? offset.left * inverseZoom : undefined,
        right:
          offset?.right !== undefined ? offset.right * inverseZoom : undefined,
        bottom:
          offset?.bottom !== undefined
            ? offset.bottom * inverseZoom
            : undefined,
        transform: `scale(${inverseZoom})`,
        transformOrigin: 'top left',
      }}
    >
      {wrapped}
      {trailing}
    </div>
  );
}
