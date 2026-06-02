// TODO: fill in real handbook content for this section.
import {
  Callout,
  Code,
  DocLink,
  H2,
  H3,
  Kbd,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'intent-system', label: 'Intent system' },
  { id: 'triggering-intent', label: 'Triggering intent' },
  { id: 'two-step-flow', label: 'Two-step flow' },
  { id: 'intent-history', label: 'Intent history' },
  { id: 'auto-layout', label: 'Auto-layout' },
  { id: 'auto-place', label: 'Incremental auto-placement' },
  { id: 'semantic-edges', label: 'Implicit semantic edges' },
  { id: 'algorithm', label: 'Layout algorithm' },
  { id: 'tips', label: 'Tips' },
];

export default function Intent() {
  return (
    <PageLayout
      title="Intent & Auto-layout"
      description="Two related capabilities for letting the AI help you organise the canvas: Intent recommends what to do next, auto-layout decides where new nodes go."
      toc={toc}
    >
      <H2>Intent system</H2>
      <P>
        The intent system reads the current canvas state and your recent
        operations, then recommends a few concrete next moves — each one
        packaged as a one-click executable plan.
      </P>

      <H2>Triggering intent</H2>
      <Table
        headers={['Trigger', 'How']}
        rows={[
          [
            'Keyboard',
            <>
              <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>I</Kbd>
            </>,
          ],
          ['Toolbar', 'The 🧠 button in the top toolbar.'],
          [
            'From a sketch',
            <>
              Select a Sketch node and click <em>Apply Sketch</em> in its
              toolbar. The AI proposes structured nodes / edges based on what
              you drew.
            </>,
          ],
        ]}
      />
      <P>
        Each trigger opens an <strong>Intent popover</strong> near the
        invocation point.
      </P>

      <H2>Two-step flow</H2>
      <H3>Step 1: choose an intent</H3>
      <P>
        Huabu sends a canvas overview (node summaries + recent ops) to the AI,
        which streams 3–5 candidate intents, e.g.:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <em>Compare the three selected articles.</em>
        </li>
        <li>
          <em>Group the search results into a new frame.</em>
        </li>
        <li>
          <em>Draft a mind-map outline from this canvas.</em>
        </li>
      </ul>
      <P>Pick a suggestion, or type your own intent in the input.</P>
      <H3>Step 2: resolve into operations</H3>
      <P>
        After picking (or typing) an intent, Huabu switches to{' '}
        <DocLink href="/docs/ai/overview">Operate mode</DocLink> and asks the AI
        to turn the intent into concrete canvas commands. The result appears
        with a <strong>change list</strong> so you can undo the whole batch.
      </P>

      <H2>Intent history</H2>
      <P>
        Every completed intent is recorded as an <em>episode</em> on disk —
        useful when you want to audit what the AI did, and used to improve
        future recommendations.
      </P>

      <H2>Auto-layout</H2>
      <P>
        The layout engine is force-directed. It reads your{' '}
        <strong>explicit edges</strong>, the structure of your{' '}
        <strong>frames</strong>, and the{' '}
        <strong>implicit semantic relationships</strong> between nodes (see
        below) and arranges accordingly.
      </P>

      <H2>Incremental auto-placement</H2>
      <P>
        The ✨ toolbar toggle (also <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+
        <Kbd>Shift</Kbd>+<Kbd>A</Kbd>) controls whether new nodes get
        auto-placed:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>On</strong> (button highlighted) — every new node slots into a
          sensible spot beside related content. Frames grow / shrink to fit
          their children, and dragging shows a target-frame outline.
        </li>
        <li>
          <strong>Off</strong> (default) — new nodes drop in the centre and stay
          put.
        </li>
      </ul>
      <P>
        Auto-place runs incrementally: the new node is the only thing the solver
        moves, so positions you&apos;ve already settled stay where you put them.
        Trigger a manual reorganisation by dragging nodes yourself.
      </P>

      <H2>Implicit semantic edges</H2>
      <P>
        Beyond the lines you draw, the layout engine looks at these
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

      <H2>Layout algorithm</H2>
      <P>
        Huabu uses <strong>fCoSE</strong> (a fast force-directed layout) with
        existing nodes pinned. Only the new node is solved for, so the result is
        predictable: nothing else moves.
      </P>

      <H2>Tips</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>During research</strong>: leave auto-layout on so AI-created
          nodes cluster near related content.
        </li>
        <li>
          <strong>After tidying</strong>: lock the key nodes (from the Layers
          panel) so subsequent layout passes can&apos;t nudge them.
        </li>
        <li>
          <strong>Inside a frame</strong>: switch the frame to column or row
          mode for automatic stacking — see{' '}
          <DocLink href="/docs/nodes/frames">Frames</DocLink>.
        </li>
      </ul>
      <Callout tone="info">
        Every AI-driven change is shown in the change list before it&apos;s
        committed — accept, tweak, or roll back as a single unit.
      </Callout>
    </PageLayout>
  );
}
