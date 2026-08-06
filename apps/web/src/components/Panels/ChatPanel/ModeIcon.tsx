// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Line-drawn icons for the two built-in agent modes, replacing the generic
 * lucide `MessageSquare` / `Sprout`.
 *
 * They use `currentColor` (stroke and dot fill) so they inherit the surrounding
 * text color — ink normally, and the active/`text-info` blue when their row or
 * chip is the current selection — matching every other menu row exactly. The
 * mode is conveyed by shape, not a fixed color:
 *
 *  - Chat: a speech bubble with three dots — the agent only talks / advises.
 *  - Agent: a cursor grabbing a node — the agent acts on the canvas.
 */

type ModeIconProps = {
  /** Rendered pixel size (width and height). Defaults to 14. */
  size?: number;
  /** SVG stroke width in viewBox units. Defaults to 6. */
  strokeWidth?: number;
  className?: string;
};

const SVG_PROPS = {
  viewBox: '10 16 92 92',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Speech bubble with three dots — the built-in "Chat" mode. */
export function ChatModeIcon({
  size = 14,
  strokeWidth = 6,
  className,
}: ModeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      strokeWidth={strokeWidth}
      className={className}
      {...SVG_PROPS}
    >
      <path d="M32 34 H80 A12 12 0 0 1 92 46 V66 A12 12 0 0 1 80 78 H54 L40 90 V78 H32 A12 12 0 0 1 20 66 V46 A12 12 0 0 1 32 34 Z" />
      <circle cx="42" cy="56" r="4.5" fill="currentColor" stroke="none" />
      <circle cx="56" cy="56" r="4.5" fill="currentColor" stroke="none" />
      <circle cx="70" cy="56" r="4.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Cursor grabbing a node — the built-in "Agent" (operate) mode. */
export function AgentModeIcon({
  size = 14,
  strokeWidth = 6,
  className,
}: ModeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      strokeWidth={strokeWidth}
      className={className}
      {...SVG_PROPS}
    >
      <rect x="24" y="28" width="38" height="30" rx="6" />
      <path d="M56 56 L56 92 L66 82 L73 96 L81 92 L74 79 L88 79 Z" />
    </svg>
  );
}
