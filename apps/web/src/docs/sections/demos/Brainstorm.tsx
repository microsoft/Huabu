import {
  Callout,
  DocLink,
  H2,
  Kbd,
  P,
  PageLayout,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'starting-point', label: 'Starting point' },
  { id: 'fast-capture', label: 'Fast capture' },
  { id: 'sketch-to-nodes', label: 'Turning a sketch into nodes' },
  { id: 'cluster', label: 'Letting the AI cluster' },
  { id: 'pick-and-pursue', label: 'Picking what to pursue' },
];

export default function Brainstorm() {
  return (
    <PageLayout
      title="Brainstorming a Concept"
      description="Brainstorming is messy on purpose. Huabu's job is to keep the mess productive — fast capture in, automatic structure out, and an AI partner that can suggest the next move when you stall."
      toc={toc}
    >
      <H2>Starting point</H2>
      <P>
        A blank canvas titled <em>&quot;Onboarding ideas&quot;</em>. A prompt in
        your head. Twenty minutes.
      </P>

      <H2>Fast capture</H2>
      <P>
        The two fastest input paths are <em>Text</em> nodes and the{' '}
        <em>Sketch</em> tool. Pick the one that matches how the idea arrives:
      </P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Single-line ideas</strong> →{' '}
          <DocLink href="/docs/nodes/text">Text</DocLink> nodes. Tap the Text
          tool, click anywhere, type, hit <Kbd>Esc</Kbd>, click again, repeat.
          Don&apos;t worry about placement.
        </li>
        <li>
          <strong>Half-baked diagrams</strong> →{' '}
          <DocLink href="/docs/nodes/sketch">Sketch</DocLink>. A flow arrow, a
          rough wireframe, a venn diagram — anything you&apos;d normally draw on
          paper.
        </li>
        <li>
          <strong>Found-on-the-internet</strong> → drag an image in or paste a
          URL; it lands as the right node type automatically.
        </li>
      </ul>

      <H2>Turning a sketch into nodes</H2>
      <P>
        When a sketch feels like it&apos;s &quot;saying&quot; something, select
        it and ask the AI in Operate mode:{' '}
        <em>&quot;turn this sketch into real nodes&quot;</em>. The strokes are
        sent to the AI, which interprets them into a batch of Notes / Frames /
        edges placed where the sketch was. You approve the change list, the
        sketch becomes structure.
      </P>
      <Callout tone="info">
        For more on how sketches are interpreted (and the prompts you can use to
        nudge the AI), see <DocLink href="/docs/nodes/sketch">Sketch</DocLink>.
      </Callout>

      <H2>Letting the AI cluster</H2>
      <P>
        After a flurry of capture, the canvas is a confetti of ideas. Press{' '}
        <Kbd>Ctrl</Kbd>/<Kbd>Cmd</Kbd>+<Kbd>I</Kbd> to call up{' '}
        <DocLink href="/docs/ai/intent">Intent</DocLink>; one of the suggestions
        is almost always something like{' '}
        <em>&quot;cluster these by theme into labelled frames&quot;</em>. Accept
        it and the AI:
      </P>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>Reads every loose node on the canvas.</li>
        <li>Picks a small number of themes.</li>
        <li>
          Creates one labelled Frame per theme and moves nodes into them, all as
          a reviewable batch.
        </li>
      </ol>

      <H2>Picking what to pursue</H2>
      <P>
        With the canvas now grouped, drop a{' '}
        <DocLink href="/docs/nodes/question">Question node</DocLink> beside each
        Frame:{' '}
        <em>&quot;which idea here is most worth prototyping first?&quot;</em>.
        The AI replies in line, treating the Frame contents as the candidate
        list. Edges from the chosen ideas back to a new{' '}
        <em>&quot;Next&quot;</em> Frame turn the brainstorm into a plan — same
        canvas, no context switch.
      </P>
    </PageLayout>
  );
}
