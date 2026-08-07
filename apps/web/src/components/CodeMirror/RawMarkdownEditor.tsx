// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Controlled CodeMirror 6 editor specialised for raw Markdown source.
 *
 * Wraps the upstream `codemirror` meta-package's `basicSetup` (line
 * numbers, history, search, bracket matching, default keymap…) plus
 * `@codemirror/lang-markdown` for syntax highlighting and nested
 * code-fence parsing.
 *
 * Intentionally **uses CodeMirror's default light theme** for the
 * first iteration — we want to evaluate the out-of-the-box look
 * before investing in a Huabu-flavoured theme that maps onto our
 * design tokens.
 *
 * API mirrors the textarea it replaces in `NotePreview`:
 *   - `value`     — current markdown (source of truth)
 *   - `onChange`  — fires with the next markdown string on user edits
 *   - `readOnly`  — disables editing
 *   - `className` — applied to the host `<div>` that owns CM's DOM
 *
 * Reconciliation strategy: same idea as `MilkdownEditor` —
 * `lastSyncedRef` records the most recent value we wrote OR received
 * from the editor, so a parent that echoes our own `onChange` back
 * via the `value` prop does NOT trigger a redundant `dispatch` that
 * would jump the user's cursor.
 *
 * Lazy-loaded by `NotePreview` via `React.lazy` so the CodeMirror
 * bundle (~80kb gzipped) only ships when the user actually opens the
 * raw-markdown mode.
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

import { huabuLightTheme } from './huabuLightTheme';

/**
 * How many spaces the Tab key inserts. Tweak here to switch between
 * 2-space (current default) and 4-space indentation across every
 * raw-markdown editor instance.
 */
const TAB_INDENT_SIZE = 2;
const TAB_INDENT_STRING = ' '.repeat(TAB_INDENT_SIZE);

// High-priority Tab binding: insert spaces instead of CodeMirror's
// default `indentMore` / focus-shift behaviour. `Prec.highest` is
// needed so this wins over `basicSetup`'s built-in `indentWithTab`
// keymap.
const tabIndentKeymap = Prec.highest(
  keymap.of([
    {
      key: 'Tab',
      run: (view) => {
        view.dispatch(view.state.replaceSelection(TAB_INDENT_STRING), {
          scrollIntoView: true,
          userEvent: 'input.type',
        });
        return true;
      },
    },
  ]),
);

export interface RawMarkdownEditorProps {
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  className?: string;
  /** Accessible label forwarded to CM's content DOM. */
  ariaLabel?: string;
}

export default function RawMarkdownEditor({
  value,
  onChange,
  readOnly,
  className,
  ariaLabel,
}: RawMarkdownEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastSyncedRef = useRef<string>(value);
  /** Latest `onChange` accessed by the update listener without remount. */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** Compartment that lets us hot-swap the read-only facet at runtime. */
  const readOnlyCompartmentRef = useRef<Compartment>(new Compartment());

  // Mount the editor once. `readOnly` and `value` are reconciled by
  // dedicated effects below so we never tear the view down on prop
  // changes (which would lose selection + history).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const readOnlyCompartment = readOnlyCompartmentRef.current;
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        markdown({ base: markdownLanguage, codeLanguages: [] }),
        EditorView.lineWrapping,
        huabuLightTheme,
        tabIndentKeymap,
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly === true)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          if (next === lastSyncedRef.current) return;
          lastSyncedRef.current = next;
          onChangeRef.current?.(next);
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    if (ariaLabel) {
      view.contentDOM.setAttribute('aria-label', ariaLabel);
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally mount-only — see dedicated reconciliation effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile external `value` changes (e.g. AI stream, undo, sibling
  // panel edits). Skip when the editor already holds this string to
  // preserve the user's selection.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === lastSyncedRef.current) return;
    lastSyncedRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  // Reconcile `readOnly` toggle via the compartment installed at mount.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(
        EditorState.readOnly.of(readOnly === true),
      ),
    });
  }, [readOnly]);

  return <div ref={hostRef} className={className} />;
}
