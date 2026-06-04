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
  { id: 'why-it-exists', label: 'Why alignment exists' },
  { id: 'multi-select-toolbar', label: 'Multi-select toolbar' },
  { id: 'six-alignments', label: 'The six alignments' },
  { id: 'distribute', label: 'Distribute' },
  { id: 'smart-snap', label: 'Smart-snap guides' },
  { id: 'frame-layouts', label: 'Frame layouts do the same job' },
  { id: 'tips', label: 'Tips' },
];

export default function Alignment() {
  return (
    <PageLayout
      title="Layout & Alignment"
      description="Four ways the canvas helps you keep things tidy: the multi-select toolbar (align + distribute), smart-snap guides while dragging, Frame layout modes, and Auto-layout for AI-created nodes."
      toc={toc}
    >
      <H2>Why alignment exists</H2>
      <P>
        A canvas is freeform on purpose, but freeform doesn&apos;t mean sloppy.
        Aligned nodes are easier for you to scan and easier for the AI to read —
        &quot;these three rows&quot; or &quot;this column&quot; becomes a real
        structural cue when the spacing is consistent. Huabu gives you four
        lightweight assists for that.
      </P>

      <H2>Multi-select toolbar</H2>
      <P>
        Select two or more nodes (drag a marquee, lasso, or <Kbd>Shift</Kbd>
        -click) and a floating toolbar appears above the selection. It collapses
        two related actions behind a single picker —{' '}
        <strong>Align &amp; Distribute</strong> — plus the usual group / delete
        / copy controls.
      </P>

      <H2>The six alignments</H2>
      <Table
        headers={['Direction', 'What it does']}
        rows={[
          [
            <strong>Left</strong>,
            'Snap all selected nodes to the leftmost edge.',
          ],
          [
            <strong>Centre (horizontal)</strong>,
            'Align all selected nodes around a shared horizontal centre.',
          ],
          [
            <strong>Right</strong>,
            'Snap all selected nodes to the rightmost edge.',
          ],
          [<strong>Top</strong>, 'Snap to the topmost edge.'],
          [
            <strong>Middle (vertical)</strong>,
            'Align around a shared vertical centre.',
          ],
          [<strong>Bottom</strong>, 'Snap to the bottommost edge.'],
        ]}
      />
      <P>
        Each is one click in the Align &amp; Distribute popover. Sizes
        aren&apos;t changed — only positions.
      </P>

      <H2>Distribute</H2>
      <P>
        With three or more nodes selected, <strong>Distribute</strong> spreads
        them evenly along the chosen axis. Use it when alignment is already
        correct but the spacing is uneven — e.g. you&apos;ve manually pulled out
        four columns and want the gaps to match.
      </P>
      <Callout tone="tip">
        Distribute respects the outermost two nodes as anchors. Resize the
        canvas region you want by moving the first and last; everything in
        between fills the gap.
      </Callout>

      <H2>Smart-snap guides</H2>
      <P>
        While you drag a single node, Huabu shows blue alignment guides whenever
        the node lines up with a neighbour&apos;s left / right / centre / top /
        middle / bottom edge. Release and the node snaps to that line. No menu —
        just drag and watch the guides appear.
      </P>
      <P>
        Hold <Kbd>Alt</Kbd> while dragging to suppress snapping for one move, if
        you want pixel-precise free placement.
      </P>

      <H2>Frame layouts do the same job</H2>
      <P>
        For repeating layouts, a{' '}
        <DocLink href="/docs/nodes/frames">Frame</DocLink> set to{' '}
        <strong>column</strong> or <strong>row</strong> mode stacks its children
        automatically — children stay aligned even as you add, remove or resize
        them. Reach for a Frame layout instead of repeatedly hitting Align &amp;
        Distribute on the same set of nodes.
      </P>

      <H2>Tips</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Align first, distribute second.</strong> Otherwise distribute
          spreads them along whichever axis isn&apos;t aligned yet, which rarely
          matches your intent.
        </li>
        <li>
          <strong>Group while you tidy.</strong> Once a cluster looks the way
          you want, <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>G</Kbd> wraps it in a
          Frame so you can drag the whole thing as one.
        </li>
        <li>
          <strong>Let Auto-layout do the rest.</strong> For AI-created nodes,{' '}
          <DocLink href="/docs/concepts/auto-layout">Auto-layout</DocLink>{' '}
          already drops them next to related content — you usually don&apos;t
          need to align after.
        </li>
      </ul>
    </PageLayout>
  );
}
