// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Fragment, useMemo } from 'react';

import {
  Callout,
  H2,
  Kbd,
  P,
  PageLayout,
  slugify,
  Table,
  type TocEntry,
} from '../../components';
import { keyboardShortcutSections } from '../../config/shortcuts';

const PASTE_SECTION = {
  id: 'paste-behaviour',
  label: 'Paste behaviour',
} as const;

/**
 * Maps shortcut-template tokens that would otherwise collide with the `+`
 * separator (e.g. `Ctrl/Cmd+Plus`) to their printable glyphs. Mirrors the
 * mapping used by `utils/platform.ts` for the in-app shortcuts modal so the
 * two surfaces stay visually consistent.
 */
const KEY_GLYPHS: Record<string, string> = {
  Plus: '+',
  Minus: '−', // U+2212 minus sign — distinct from the `+` separator
  Equal: '=',
};

/**
 * Render a shortcut template from `config/shortcuts.ts` as a row of
 * `<Kbd>` chips. Unlike the in-app modal — which collapses `Ctrl/Cmd` to
 * the platform-native modifier — the docs always render both `Ctrl` and
 * `Cmd` so the page reads correctly regardless of the visitor's OS.
 *
 * Handles three template shapes:
 *   - `Key+Key+...` combinations (e.g. `Ctrl/Cmd+Shift+Z`)
 *   - `Key / Key` alternatives (e.g. `Delete / Backspace`)
 *   - `Key (qualifier)` annotations (e.g. `Space (hold)`)
 */
function ShortcutKbd({ template }: { template: string }) {
  if (template.includes(' / ')) {
    const alternatives = template.split(' / ');
    return (
      <>
        {alternatives.map((alt, index) => (
          <Fragment key={`alt-${index}`}>
            {index > 0 && ' / '}
            <ShortcutKbd template={alt} />
          </Fragment>
        ))}
      </>
    );
  }

  const qualifierMatch = /^(.+?)\s+\(([^)]+)\)$/.exec(template);
  if (qualifierMatch) {
    const [, base, qualifier] = qualifierMatch;
    return (
      <>
        <ShortcutKbd template={base} /> ({qualifier})
      </>
    );
  }

  const parts = template.split('+').map((part) => part.trim());
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={`part-${index}`}>
          {index > 0 && '+'}
          {part === 'Ctrl/Cmd' ? (
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>
            </>
          ) : (
            <Kbd>{KEY_GLYPHS[part] ?? part}</Kbd>
          )}
        </Fragment>
      ))}
    </>
  );
}

export default function Shortcuts() {
  const toc = useMemo<TocEntry[]>(
    () => [
      ...keyboardShortcutSections.map((section) => ({
        id: slugify(section.title),
        label: section.title,
      })),
      { id: PASTE_SECTION.id, label: PASTE_SECTION.label },
    ],
    [],
  );

  return (
    <PageLayout
      title="Keyboard Shortcuts"
      description={
        <>
          <Kbd>Ctrl</Kbd> on Windows / Linux, <Kbd>Cmd</Kbd> (⌘) on macOS — the
          tables below write it as <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>. Press{' '}
          <Kbd>?</Kbd> in any Space to view the same list in-app. Shortcuts in
          the General section are available only in the desktop app.
        </>
      }
      toc={toc}
    >
      {keyboardShortcutSections.map((section) => (
        <Fragment key={section.title}>
          <H2>{section.title}</H2>
          <Table
            headers={['Shortcut', 'Action']}
            rows={section.items.map((item) => [
              <ShortcutKbd key={item.keys} template={item.keys} />,
              item.description,
            ])}
          />
        </Fragment>
      ))}

      <H2>{PASTE_SECTION.label}</H2>
      <P>
        <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>V</Kbd> resolves to different node
        types depending on what&apos;s on your clipboard:
      </P>
      <Table
        headers={['Clipboard contents', 'Result']}
        rows={[
          [
            'Space nodes copied earlier',
            'Pasted as duplicates at the cursor position.',
          ],
          ['Image file', 'Creates an Image node and uploads it.'],
          ['PDF file', 'Creates a PDF node and uploads it.'],
          ['Video file', 'Creates a Video node and uploads it.'],
          [
            'One or more URLs (one per line)',
            'Auto-detected as image / PDF / web page / YouTube; one node per line.',
          ],
          ['Plain text', 'Creates a Note with the pasted text.'],
        ]}
      />

      <Callout tone="info">
        Shortcuts adapt to your platform automatically — the modifier shows up
        as <Kbd>Cmd</Kbd> on macOS and <Kbd>Ctrl</Kbd> on Windows / Linux.
      </Callout>

      <Callout tone="info">
        On the <strong>Drag and drop</strong> row above: the cursor reflects the
        active mode — a <strong>+</strong> badge means copy, no badge means
        move. Drags that can&apos;t mutate their source (AI chat cards, web /
        image cards, external files or URLs) always fall back to copy regardless
        of the modifier.
      </Callout>
    </PageLayout>
  );
}
