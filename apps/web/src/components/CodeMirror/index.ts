// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Public barrel for the CodeMirror wrapper(s).
 *
 * Only the symbols re-exported here may be imported from outside
 * `apps/web/src/components/CodeMirror/`. Keeps `@codemirror/*` imports
 * confined so we can rip-and-replace the underlying editor library
 * later without touching every consumer.
 */

export { default as RawMarkdownEditor } from './RawMarkdownEditor';
export type { RawMarkdownEditorProps } from './RawMarkdownEditor';
