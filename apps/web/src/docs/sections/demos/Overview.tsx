import { BookOpen, Lightbulb, Sparkles } from 'lucide-react';

import {
  CardGrid,
  H2,
  NavCard,
  P,
  PageLayout,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'how-to-read', label: 'How to read these' },
  { id: 'cases', label: 'The cases' },
];

export default function DemosOverview() {
  return (
    <PageLayout
      title="Demo Cases"
      description="Short, opinionated walk-throughs of three common shapes of work Huabu is good at. Each one shows the canvas mid-flight so you can see what the surface looks like once the AI and you have been at it for a while."
      toc={toc}
    >
      <H2>How to read these</H2>
      <P>
        Every demo follows the same arc: <em>what you start with</em>,{' '}
        <em>what you put on the canvas</em>, <em>how the AI helps</em>, and{' '}
        <em>what you end up with</em>. They&apos;re not step-by-step recipes —
        for those, see the reference pages each demo links to. Treat them as
        worked examples that show how the pieces compose.
      </P>

      <H2>The cases</H2>
      <CardGrid>
        <NavCard
          to="/docs/demos/research-review"
          icon={BookOpen}
          eyebrow="Reading"
          title="Reading a Research Topic"
          description="Drop in a stack of PDFs and web articles, build a comparison, and end up with a written synthesis you can hand off."
        />
        <NavCard
          to="/docs/demos/product-spec"
          icon={Sparkles}
          eyebrow="Writing"
          title="Drafting a Product Spec"
          description="Sketch the problem, capture decisions as nodes, let the AI roll them up into a coherent spec frame."
        />
        <NavCard
          to="/docs/demos/brainstorm"
          icon={Lightbulb}
          eyebrow="Thinking"
          title="Brainstorming a Concept"
          description="From scrappy sketches and one-line notes to a clustered, labelled idea map you can show someone."
        />
      </CardGrid>
    </PageLayout>
  );
}
