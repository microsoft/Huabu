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
  { id: 'what-a-frame-is', label: 'What a frame is' },
  { id: 'layout-modes', label: 'Layout modes' },
  { id: 'frame-sizing', label: 'Frame sizing' },
  { id: 'auto-reflow', label: 'Auto-reflow on child resize' },
  { id: 'locking-frames', label: 'Locking frames' },
  { id: 'creating-and-dissolving', label: 'Creating & dissolving' },
];

export default function Frames() {
  return (
    <PageLayout
      title="Frames"
      description='A Frame is a labelled rectangle that groups nodes spatially. Move a frame and its children move with it; ask the AI to summarise "this frame" and it knows exactly which nodes you mean.'
      toc={toc}
    >
      <H2>What a frame is</H2>
      <P>
        Drop a frame on the canvas, then drag other nodes inside its bounds —
        they become its children. Frames can be nested, and dragging a parent
        carries every descendant.
      </P>
      <P>
        Frames also act as <strong>context units for the AI</strong>. When the
        AI generates an answer about &quot;the search-results frame&quot;, it
        knows the exact subset of the canvas you&apos;re referring to.
      </P>

      <H2>Layout modes</H2>
      <P>Each frame has one of three layout modes (set from its toolbar):</P>
      <Table
        headers={['Mode', 'Behaviour']}
        rows={[
          [
            <strong>Free</strong>,
            'Default. Children are positioned freely; the frame just labels and groups them.',
          ],
          [
            <strong>Column</strong>,
            'Children are stacked top to bottom, sized to the frame width. Order matches their Y position.',
          ],
          [
            <strong>Row</strong>,
            'Children are laid out left to right, sized to the frame height. Order matches their X position.',
          ],
        ]}
      />

      <H2>Frame sizing</H2>
      <P>
        Independently of the layout mode, each frame has a <em>sizing</em>{' '}
        policy you can flip from its toolbar:
      </P>
      <Table
        headers={['Sizing', 'Behaviour']}
        rows={[
          [
            <strong>Hug</strong>,
            'Default. The frame auto-fits to wrap its children — adding, removing, dragging, or resizing a child reshapes the frame.',
          ],
          [
            <strong>Manual</strong>,
            'The frame keeps the size you set. Children can move freely inside without reshaping the container. Useful when you want a fixed canvas region.',
          ],
        ]}
      />
      <Callout tone="info">
        <strong>Manual</strong> sizing also applies to <strong>Column</strong>{' '}
        and <strong>Row</strong> frames: the structured solver still packs
        children into tracks, but the frame box stays pinned to whatever size
        you set. Children that don&apos;t fit overflow the main axis (top edge
        for column, left edge for row).
      </Callout>

      <H2>Auto-reflow on child resize</H2>
      <P>
        In column and row mode the frame reflows whenever a child&apos;s size
        changes — no matter how the change happened:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>Dragging a resize handle.</li>
        <li>Entering precise W / H values in the node toolbar.</li>
        <li>Toggling a Note between auto-height and fixed-height.</li>
        <li>
          Typing into a Note (the node grows or shrinks) — the parent reflows
          immediately.
        </li>
        <li>
          An async asset (image, PDF page) finishing load with a different
          intrinsic size than the placeholder.
        </li>
      </ul>
      <Callout tone="info">
        Free-mode frames stay as you left them. Switch to column / row when you
        want layout to follow content automatically.
      </Callout>

      <H2>Locking frames</H2>
      <P>
        Locking a frame (via the Layers panel) changes its behaviour in several
        ways:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>The frame itself can&apos;t be dragged or resized.</li>
        <li>
          Children become non-draggable individually (you can still select
          them).
        </li>
        <li>The frame stops auto-resizing to fit its content.</li>
        <li>The frame stops accepting / releasing children on drag-over.</li>
      </ul>
      <P>
        Lock a frame to freeze an arrangement you&apos;ve carefully tuned.
        Unlock it to keep editing.
      </P>

      <H2>Creating & dissolving</H2>
      <Table
        headers={['Action', 'How']}
        rows={[
          [
            'Create empty frame',
            <>Toolbar &gt; Frame, then drag a rectangle on the canvas.</>,
          ],
          [
            'Wrap a selection',
            <>
              Select two or more nodes and press <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+
              <Kbd>G</Kbd>.
            </>,
          ],
          [
            'Change layout mode',
            <>
              Open the frame&apos;s expanded panel (double-click) or use the
              toolbar.
            </>,
          ],
          [
            'Dissolve (ungroup)',
            <>
              Frame toolbar &gt; <em>Ungroup</em>. Children stay in place but
              the frame is removed.
            </>,
          ],
        ]}
      />
      <Callout tone="tip">
        For deeper structure, nest frames: a top-level frame per workstream,
        with smaller frames inside for sub-topics. The Layers panel makes the
        tree easy to navigate. See{' '}
        <DocLink href="/docs/concepts/layers-panel">Layers Panel</DocLink>.
      </Callout>
    </PageLayout>
  );
}
