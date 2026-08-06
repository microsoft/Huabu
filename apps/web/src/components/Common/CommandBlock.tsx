// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Terminal-style block shared by assistant tool cards (`ToolCallCard`,
 * `PermissionCard`). Renders the command on a prompt line and, when
 * present, its captured output below — visually grouped and clearly
 * distinct from prose text. Uses standard design tokens; scrolls when
 * tall.
 */
interface CommandBlockProps {
  /** The shell command (without leading prompt). */
  text: string;
  /** Captured stdout/stderr from the command, if any. */
  output?: string;
  className?: string;
}

export function CommandBlock({ text, output, className }: CommandBlockProps) {
  return (
    <div
      className={`border-edge-default bg-bg-default max-h-48 overflow-auto rounded border font-mono text-xs${
        className ? ` ${className}` : ''
      }`}
    >
      <pre className="text-fg-default px-2 py-1.5 whitespace-pre-wrap">
        <span className="text-fg-subtle select-none">$ </span>
        {text}
      </pre>
      {output && (
        <pre className="text-fg-muted bg-surface border-edge-default/60 border-t px-2 py-1.5 whitespace-pre-wrap">
          {output}
        </pre>
      )}
    </div>
  );
}
