// TODO: fill in real handbook content for this section.
import {
  Callout,
  DocLink,
  H2,
  Kbd,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'what-a-note-is', label: 'What a Note is' },
  { id: 'creating-notes', label: 'Creating Notes' },
  { id: 'editing', label: 'Editing' },
  { id: 'sizing', label: 'Sizing' },
  { id: 'dropping-blocks-in', label: 'Dropping blocks in' },
  { id: 'toolbar', label: 'Toolbar' },
];

export default function NoteNode() {
  return (
    <PageLayout
      title="Note"
      description="Notes are Markdown blocks for thoughts, outlines, and AI-written prose. They're the canvas's main text container and the most common node type."
      toc={toc}
    >
      <H2>What a Note is</H2>
      <P>
        A Note is a rich Markdown card. Headings, lists, quotes, code blocks,
        inline emphasis and links all render in place. The body is stored as
        Markdown so it round-trips cleanly to disk, to the AI, and back to the
        editor.
      </P>

      <H2>Creating Notes</H2>
      <Table
        headers={['Source', 'How']}
        rows={[
          ['Toolbar', 'Pick Note from the canvas toolbar.'],
          [
            'Paste text',
            'Paste plain text or Markdown on an empty canvas spot.',
          ],
          [
            'Drag a block',
            'Drag a block (paragraph, heading, list item) out of an existing Note to spawn a new one.',
          ],
          [
            'From chat',
            'Drag an AI response from the chat panel onto the canvas.',
          ],
        ]}
      />

      <H2>Editing</H2>
      <P>
        Double-click a Note (or press <Kbd>Enter</Kbd> while it&apos;s selected)
        to open the right-side lightbox with the full block editor. Single-line
        edits can also be made in place via the inline editor.
      </P>

      <H2>Sizing</H2>
      <P>
        Notes default to <em>auto-height</em>: they grow and shrink with their
        content. Drag the bottom-right resize handle to set a fixed width and
        height; toggle back to auto from the toolbar. Auto-height Notes inside a
        column or row Frame trigger reflow whenever the text changes.
      </P>

      <H2>Dropping blocks in</H2>
      <P>
        Drop a Note block onto another Note to merge them. On the tile it
        appends to the end; in the expanded panel it inserts after the cursor
        block. The target shows a blue ring while you hover. Default is move —
        hold the copy modifier (<Kbd>Option</Kbd> on macOS, <Kbd>Ctrl</Kbd>
        elsewhere) to keep the source. A locked Note can&apos;t receive blocks,
        so the drop spawns a new node instead.
      </P>

      <H2>Toolbar</H2>
      <P>The single-select toolbar surfaces:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Expand</strong> — open the lightbox editor.
        </li>
        <li>
          <strong>Copy content</strong> — copy the Markdown to the clipboard.
        </li>
      </ul>
      <Callout tone="info">
        See <DocLink href="/docs/nodes/content">Node Content</DocLink> for how
        Note bodies are ingested into the context Huabu sends to the AI.
      </Callout>
    </PageLayout>
  );
}
