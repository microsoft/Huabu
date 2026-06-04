import {
  Callout,
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
  { id: 'what-it-is', label: 'What Intent does' },
  { id: 'triggering', label: 'Triggering Intent' },
  { id: 'two-step-flow', label: 'Two-step flow' },
  { id: 'history', label: 'Intent history' },
  { id: 'tips', label: 'Tips' },
];

export default function Intent() {
  return (
    <PageLayout
      title="Intent"
      description="Intent reads the current canvas state and your recent operations, then proposes a few concrete next moves — each one packaged as a one-click executable plan you can review before it touches the canvas."
      toc={toc}
    >
      <H2>What Intent does</H2>
      <P>
        Most canvas work has a natural rhythm: you capture, the canvas gets
        busy, you pause, and then it&apos;s not obvious what the highest-value
        next move is. Intent is built for that pause. It looks at what&apos;s on
        the canvas (and what you did last), suggests 3–5 things worth doing, and
        turns whichever one you pick into a reviewable batch of edits.
      </P>

      <H2>Triggering Intent</H2>
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
              toolbar. The AI proposes structured nodes and edges based on what
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
      <H3>Step 1 — Choose an intent</H3>
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

      <H3>Step 2 — Resolve into operations</H3>
      <P>
        After picking (or typing) an intent, Huabu switches to{' '}
        <DocLink href="/docs/ai/agent-mode">Agent Mode</DocLink> and asks the AI
        to turn the intent into concrete canvas operations. The result appears
        with a <strong>change list</strong> so you can accept, tweak or undo the
        whole batch as a single unit.
      </P>

      <H2>Intent history</H2>
      <P>
        Every completed intent is recorded as an <em>episode</em> on disk —
        useful when you want to audit what the AI did, and used to improve
        future recommendations.
      </P>

      <H2>Tips</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Pre-select to scope.</strong> If a few nodes matter more than
          the rest, select them before triggering — the suggestions narrow
          accordingly.
        </li>
        <li>
          <strong>Use it after capture sprints.</strong> Intent shines right
          after you&apos;ve dumped a lot of raw material on the canvas and want
          a hand structuring it.
        </li>
        <li>
          <strong>Pair with Auto-layout.</strong> When Intent emits new nodes,{' '}
          <DocLink href="/docs/concepts/auto-layout">Auto-layout</DocLink>{' '}
          places them next to related content automatically.
        </li>
      </ul>
      <Callout tone="info">
        Every AI-driven change is shown in the change list before it&apos;s
        committed — accept, tweak, or roll back as a single unit.
      </Callout>
    </PageLayout>
  );
}
// TODO: fill in real handbook content for this section.
