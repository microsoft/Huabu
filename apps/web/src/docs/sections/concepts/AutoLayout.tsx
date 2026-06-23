import {
  Callout,
  Code,
  DocLink,
  H2,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'what-it-does', label: 'What Auto-layout does' },
  { id: 'frame-sizing', label: 'Frame sizing' },
  { id: 'incremental', label: 'Incremental placement' },
  { id: 'semantic-edges', label: 'Implicit semantic relationships' },
  { id: 'algorithm', label: 'The algorithm' },
  { id: 'tips', label: 'Tips' },
];

export default function AutoLayout() {
  return (
    <PageLayout
      title="Auto-layout"
      description="Auto-layout decides where a new node lands on the canvas. It reads your explicit edges, the structure of your frames and a handful of implicit semantic relationships, then slots each new node beside related content — without nudging anything you've already placed."
      toc={toc}
    >
      <H2>What Auto-layout does</H2>
      <P>
        Whenever a node is created without an explicit position, the layout
        engine looks at the whole canvas, picks a sensible neighbourhood for it
        based on its relationships, and slots it in. Frames grow or shrink to
        fit their children (unless the frame opts into manual sizing — see
        below) and dragging a node shows a target-frame outline.
      </P>

      <H2>Frame sizing</H2>
      <P>
        Frame size is controlled by a per-frame <em>sizing policy</em> in the
        Frame node toolbar — not by any global setting. Two options:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Hug</strong> (default) — the frame auto-fits to wrap its
          children. Adding, removing, dragging, or resizing a child reshapes the
          frame in real time, with a live preview during the drag.
        </li>
        <li>
          <strong>Manual</strong> — the frame keeps the size you set. The engine
          never reshapes it, so children can move freely inside (or even past
          the edges) without the container shifting.
        </li>
      </ul>
      <Callout tone="info">
        <strong>Manual</strong> sizing also works for <strong>Column</strong>{' '}
        and <strong>Row</strong> frames: the structured solver still packs
        children into tracks (so order and track assignment stay valid), but
        leaves the frame size pinned to whatever you set. Children that
        don&apos;t fit may overflow the main axis (top edge for column, left
        edge for row).
      </Callout>

      <H2>Incremental placement</H2>
      <P>
        Auto-layout runs <strong>incrementally</strong>: the new node is the
        only thing the solver moves. Positions you&apos;ve already settled stay
        where you put them, so the canvas never reshuffles behind your back. To
        trigger a manual reorganisation, drag nodes yourself or change a
        Frame&apos;s layout mode (see{' '}
        <DocLink href="/docs/nodes/frames">Frame Node</DocLink>).
      </P>

      <H2>Implicit semantic relationships</H2>
      <P>
        Beyond the edges you draw, the layout engine looks at these
        relationships and pulls related nodes closer:
      </P>
      <Table
        headers={['Relationship', 'Weight', 'Description']}
        rows={[
          [<strong>User edge</strong>, <Code>1.0</Code>, 'Lines you drew.'],
          [
            <strong>Research citation</strong>,
            <Code>0.6</Code>,
            'A synthesis node and the source node it cites.',
          ],
          [
            <strong>Knowledge source</strong>,
            <Code>0.4</Code>,
            'A derived node and its origin node.',
          ],
          [
            <strong>Same intent thread</strong>,
            <Code>0.3</Code>,
            'Nodes produced by the same Intent run.',
          ],
          [
            <strong>Same chat thread</strong>,
            <Code>0.3</Code>,
            'Nodes dragged out of the same chat conversation.',
          ],
          [
            <strong>Same frame</strong>,
            <Code>0.2</Code>,
            'Siblings inside the same frame.',
          ],
        ]}
      />
      <Callout tone="info">
        Multiple relationships between the same two nodes don&apos;t stack —
        only the strongest is used.
      </Callout>

      <H2>The algorithm</H2>
      <P>
        Auto-layout uses <strong>fCoSE</strong> (a fast force-directed layout)
        with existing nodes pinned. Only the new node is solved for, so the
        result is predictable: nothing else moves. Frame siblings respect the
        parent Frame&apos;s layout mode (free / column / row) rather than being
        pulled by global forces.
      </P>

      <H2>Tips</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Pin a frame&apos;s size</strong>: switch a free-layout frame
          to <strong>Manual</strong> sizing when you want a fixed canvas region
          — e.g. a workspace zone you&apos;ll resize by hand instead of
          following its contents.
        </li>
        <li>
          <strong>After tidying</strong>: lock the key nodes (from the Layers
          panel) so subsequent layout passes can&apos;t nudge them.
        </li>
        <li>
          <strong>Inside a Frame</strong>: switch the Frame to column or row
          mode for automatic stacking — see{' '}
          <DocLink href="/docs/nodes/frames">Frame Node</DocLink>.
        </li>
      </ul>
    </PageLayout>
  );
}
