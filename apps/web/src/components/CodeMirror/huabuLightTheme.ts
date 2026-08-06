// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * CodeMirror 6 theme that maps onto Huabu's design tokens
 * (`apps/web/src/index.css` `:root`).
 *
 * **Light mode only** for the first iteration. The theme references
 * tokens via `var(--token)` rather than literal hex, so a future
 * dark-mode pass only needs a second `EditorView.theme` (selected via
 * the `dark` class on `<html>`) — the values themselves already swap
 * thanks to the existing CSS variable cascade in `index.css`.
 *
 * Design choices for Markdown source:
 *   - Headings keep the **same font-size** as body text so the
 *     monospaced grid stays aligned (per CodeMirror convention for
 *     code editors). Hierarchy is signalled via weight + `--info`
 *     color, mirroring the active/selected state convention used
 *     across the app.
 *   - Markdown markers (`#`, `**`, `>`, `-`) are rendered in
 *     `--fg-subtle` so the **decorated text** carries the visual
 *     weight, not the syntax itself.
 *   - Inline code / fenced-code use `--warning` (warm orange) which
 *     reads as "code" without competing with `--info` links/headings.
 *   - Quotes use `--fg-muted` + italic for the dimmed convention.
 *   - Links use `--info` + underline.
 *
 * Re-exported as a single `Extension` so call-sites just append it
 * to their `extensions: [...]` array.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

import type { Extension } from '@codemirror/state';

// Centralised token references. Using CSS variables (rather than
// duplicating hex values) means edits to `index.css` propagate here
// automatically, and a future dark-mode override "just works" via the
// existing variable cascade.
const FG_DEFAULT = 'var(--fg-default)';
const FG_MUTED = 'var(--fg-muted)';
const FG_SUBTLE = 'var(--fg-subtle)';
const BG_DEFAULT = 'var(--bg-default)';
const BG_SURFACE = 'var(--bg-surface)';
const BG_HOVER = 'var(--bg-hover)';
const EDGE_DEFAULT = 'var(--edge-default)';
const INFO = 'var(--info)';
const INFO_BG = 'var(--info-bg)';
const INFO_BG_HOVER = 'var(--info-bg-hover)';
const SUCCESS = 'var(--success)';
const WARNING = 'var(--warning)';
const DANGER = 'var(--danger)';

const chrome = EditorView.theme(
  {
    '&': {
      color: FG_DEFAULT,
      backgroundColor: 'transparent',
    },
    // Strip CodeMirror's default dotted focus outline on the editor
    // shell. Focus state is already implied by the visible caret and
    // the active-line tint; the OS-style dotted border looks
    // out-of-place inside Huabu's panel chrome.
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-scroller': {
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: '13px',
      lineHeight: '1.65',
    },
    '.cm-content': {
      caretColor: FG_DEFAULT,
      padding: '4px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: FG_DEFAULT,
    },

    // Selection: tinted with info-bg so it reads as "active" without
    // clashing with the warning/success syntax colors. We have to set
    // both the `::selection` pseudo and the `.cm-selectionBackground`
    // class because CM swaps strategies between focused / unfocused
    // and between native / drawn selection layers.
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      {
        backgroundColor: INFO_BG,
      },
    '.cm-selectionMatch': {
      backgroundColor: INFO_BG_HOVER,
    },

    // Active line: very subtle to avoid competing with selection.
    '.cm-activeLine': {
      backgroundColor: BG_HOVER,
    },
    '.cm-activeLineGutter': {
      backgroundColor: BG_HOVER,
      color: FG_DEFAULT,
    },

    // Gutter (line numbers + fold markers).
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: FG_SUBTLE,
      border: 'none',
      borderRight: `1px solid ${EDGE_DEFAULT}`,
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 10px 0 6px',
    },

    // Bracket matching.
    '.cm-matchingBracket': {
      backgroundColor: INFO_BG,
      outline: `1px solid ${INFO}`,
      borderRadius: '2px',
    },
    '.cm-nonmatchingBracket': {
      color: DANGER,
    },

    // Tooltips (autocomplete, hover, lint).
    '.cm-tooltip': {
      backgroundColor: BG_SURFACE,
      color: FG_DEFAULT,
      border: `1px solid ${EDGE_DEFAULT}`,
      borderRadius: '6px',
      boxShadow: '0 2px 12px rgba(0, 0, 0, 0.08)',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: INFO_BG,
      color: FG_DEFAULT,
    },

    // Search & replace panel.
    '.cm-panels': {
      backgroundColor: BG_DEFAULT,
      color: FG_DEFAULT,
      borderTop: `1px solid ${EDGE_DEFAULT}`,
    },
    '.cm-panel.cm-search input, .cm-panel.cm-search [name="replace"]': {
      backgroundColor: BG_SURFACE,
      color: FG_DEFAULT,
      border: `1px solid ${EDGE_DEFAULT}`,
      borderRadius: '4px',
      padding: '2px 6px',
    },
    '.cm-panel.cm-search button': {
      backgroundColor: BG_SURFACE,
      color: FG_MUTED,
      border: `1px solid ${EDGE_DEFAULT}`,
      borderRadius: '4px',
    },
    '.cm-panel.cm-search button:hover': {
      backgroundColor: BG_HOVER,
    },
    '.cm-panel.cm-search label': {
      color: FG_MUTED,
    },
  },
  { dark: false },
);

const highlight = HighlightStyle.define([
  // ── Headings ─────────────────────────────────────────────────────
  // Kept at uniform font-size to preserve the monospaced grid; weight
  // + color signal hierarchy. h4–h6 lose the extra-bold weight so
  // deeply-nested outlines don't look "shouty".
  { tag: t.heading1, color: INFO, fontWeight: '700' },
  { tag: t.heading2, color: INFO, fontWeight: '700' },
  { tag: t.heading3, color: INFO, fontWeight: '700' },
  { tag: t.heading4, color: INFO, fontWeight: '600' },
  { tag: t.heading5, color: INFO, fontWeight: '600' },
  { tag: t.heading6, color: INFO, fontWeight: '600' },

  // ── Inline emphasis ──────────────────────────────────────────────
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },

  // ── Links / URLs ────────────────────────────────────────────────
  { tag: t.link, color: INFO, textDecoration: 'underline' },
  { tag: t.url, color: INFO },

  // ── Code (inline & fenced) ───────────────────────────────────────
  // `monospace` covers both `` `inline` `` and the contents of code
  // fences. Warm warning color reads as "code" without competing
  // with --info links/headings. No background tint — per-character
  // bg on fenced blocks looks fragmented.
  { tag: t.monospace, color: WARNING },

  // ── Quotes ──────────────────────────────────────────────────────
  { tag: t.quote, color: FG_MUTED, fontStyle: 'italic' },

  // ── Lists ───────────────────────────────────────────────────────
  { tag: t.list, color: INFO },

  // ── Horizontal rule (---) ───────────────────────────────────────
  { tag: t.contentSeparator, color: FG_SUBTLE },

  // ── Markdown markers (`#`, `**`, `>`, `-`, `[`, `]`, `(`, `)`) ──
  // Subtle so the decoration on adjacent text carries the weight.
  { tag: t.processingInstruction, color: FG_SUBTLE },

  // ── HTML / YAML front-matter blocks ─────────────────────────────
  { tag: t.meta, color: FG_MUTED },

  // ── Escape sequences (e.g. `\*`) ────────────────────────────────
  { tag: t.escape, color: FG_SUBTLE },

  // ── Task list literals ([ ] / [x]) ──────────────────────────────
  { tag: t.literal, color: INFO },

  // ── Generic code tags (kept for future fenced sub-language
  //    highlighting; harmless when sub-languages aren't enabled). ──
  { tag: t.keyword, color: WARNING, fontWeight: '600' },
  { tag: t.string, color: SUCCESS },
  { tag: t.number, color: DANGER },
  { tag: t.bool, color: WARNING, fontWeight: '600' },
  { tag: t.atom, color: WARNING },
  { tag: t.comment, color: FG_SUBTLE, fontStyle: 'italic' },
  { tag: t.operator, color: FG_MUTED },
  { tag: t.punctuation, color: FG_MUTED },
]);

export const huabuLightTheme: Extension = [
  chrome,
  syntaxHighlighting(highlight),
];
