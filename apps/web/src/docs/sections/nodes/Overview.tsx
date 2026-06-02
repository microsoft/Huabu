// TODO: fill in real handbook content for this section.
import {
  Callout,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'the-nine-types', label: 'The nine node types' },
  { id: 'expand-and-edit', label: 'Expand & edit' },
  { id: 'single-select-toolbar', label: 'Single-select toolbar' },
  { id: 'multi-select-toolbar', label: 'Multi-select toolbar' },
  { id: 'locking', label: 'Locking' },
];

export default function NodesOverview() {
  return (
    <PageLayout
      title="Node Types"
      description="Huabu ships nine node types. The four media types and Note / Text are pure content. Frame is structure. Sketch and Question are interactive. This page lists what each one does at a glance — dedicated pages go deeper where it matters."
      toc={toc}
    >
      <H2>The nine node types</H2>
      <Table
        headers={['Type', 'What it carries', 'How you create it']}
        rows={[
          [
            <strong>Note</strong>,
            'Rich Markdown for thoughts, outlines, AI-written prose. Edited in a block editor.',
            'Toolbar · paste text · drag a block out of another Note · chat drag-to-canvas.',
          ],
          [
            <strong>Text</strong>,
            'Short plain text for titles, labels, captions. Edited in place with size / colour / weight controls.',
            'Toolbar · paste short text.',
          ],
          [
            <strong>Image</strong>,
            'PNG / JPG / GIF / WebP / SVG. Node auto-fits the source aspect ratio.',
            'Upload · paste · drag a file · paste an image URL · PDF selection screenshot.',
          ],
          [
            <strong>PDF</strong>,
            'PDF document with page thumbnails. Selection mode lets you drag text or screenshots back to the canvas.',
            'Upload · paste · paste URL.',
          ],
          [
            <strong>Video</strong>,
            'MP4 / WebM / MOV / OGG plus YouTube embeds.',
            'Upload · paste · paste URL.',
          ],
          [
            <strong>Web</strong>,
            'Captured URL with the article body extracted in the background.',
            'Paste URL · link dialog.',
          ],
          [
            <strong>Frame</strong>,
            'Labelled group container with free / column / row layout.',
            <>
              Toolbar (drag to size) · <em>group selection</em> (Ctrl/Cmd+G).
              See <DocLink href="/docs/nodes/frames">Frames</DocLink>.
            </>,
          ],
          [
            <strong>Sketch</strong>,
            'Freehand strokes you can ask the AI to interpret.',
            <>
              Toolbar (drag to draw). See{' '}
              <DocLink href="/docs/nodes/sketch">Sketch</DocLink>.
            </>,
          ],
          [
            <strong>Question</strong>,
            'A sticky-note question the AI answers in a connected reply node.',
            <>
              Toolbar. See{' '}
              <DocLink href="/docs/nodes/question">Question Nodes</DocLink>.
            </>,
          ],
        ]}
      />

      <H2>Expand & edit</H2>
      <P>
        Most nodes open a focused editor or viewer when you double-click them —
        either the right-side lightbox or an in-place editor:
      </P>
      <Table
        headers={['Node', 'Double-click opens']}
        rows={[
          ['Note', 'Right-side lightbox with the Markdown block editor.'],
          ['Text', 'Inline editor — no lightbox; type directly on the node.'],
          ['Image / Video', 'Lightbox with a zoomable viewer / player.'],
          [
            'PDF',
            'Lightbox PDF viewer with page thumbnails, download, and selection mode.',
          ],
          ['Web', 'Lightbox preview of the extracted article body.'],
          [
            'Frame',
            'Title editor and layout-mode picker (free / column / row).',
          ],
          ['Question', 'Inline editor on the node — no lightbox.'],
          ['Sketch', 'No lightbox; you draw directly on the canvas.'],
        ]}
      />

      <H2>Single-select toolbar</H2>
      <P>
        When a single node is selected, a small floating toolbar appears above
        it. Its actions are tailored to the node type but follow a consistent
        layout (open / primary actions on the left, type-specific controls in
        the middle, destructive actions on the right).
      </P>
      <Table
        headers={['Node', 'Toolbar highlights']}
        rows={[
          ['Note', 'Expand · Copy content.'],
          ['Web', 'Open original URL · Expand.'],
          ['PDF', 'Expand · Download · Set / clear cover image.'],
          ['Image / Video', 'Expand.'],
          [
            'Text',
            'Font / size · bold / italic / underline / strike · text & background colour.',
          ],
          ['Question', 'Edit · Run / Stop · View answers.'],
          ['Frame', 'Switch layout (free / column / row) · Ungroup.'],
          ['Sketch', 'Pen colour & size · Apply Sketch (AI interpret).'],
        ]}
      />

      <H2>Multi-select toolbar</H2>
      <P>
        Selecting two or more nodes brings up a different toolbar with alignment
        (left / centre / right / top / middle / bottom), distribution (spread
        overlapping nodes), and <em>group into Frame</em>
        (also <code>Ctrl/Cmd+G</code>).
      </P>

      <H2>Locking</H2>
      <P>
        Lock any node from the Layers panel. Locked nodes can&apos;t be dragged
        or resized and are treated as fixed points by auto-layout — but content
        remains editable. Locking a frame freezes its children too and stops it
        from auto-resizing.
      </P>
      <Callout tone="info">
        Want more on how node content is stored and retrieved by the AI? See{' '}
        <DocLink href="/docs/nodes/content">Node Content</DocLink>.
      </Callout>
    </PageLayout>
  );
}
