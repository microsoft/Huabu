/**
 * Gallery-style page that lives next to Overview / Quick Start in
 * the pinned sidebar. Not a tutorial — a vertical scroll of
 * scenarios, each one a screenshot and a sentence about who
 * Huabu fits and how.
 *
 * Uses its own loose layout (no `PageLayout`) so it can breathe
 * like a marketing page.
 */

import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import { H2, P } from '../components';
import { cn } from '../components/cn';

type ShowcaseScene = {
  eyebrow: string;
  title: string;
  body: string;
  /** Optional jump-to link rendered as a subtle CTA. */
  cta?: { label: string; to: string };
};

const scenes: ShowcaseScene[] = [
  {
    eyebrow: 'Research',
    title: 'Read a dense paper without losing the thread',
    body: 'Drop a stack of PDFs onto the canvas, attach a Note beside each one for your own summary, and let the AI synthesise across them when you are ready. The sources stay visible while you write.',
    cta: { label: 'See the walkthrough idea', to: '/docs/quickstart' },
  },
  {
    eyebrow: 'Product thinking',
    title: 'Turn a messy decision into a one-page spec',
    body: 'Capture context, screenshots and half-baked options as separate nodes. When you are ready, ask the AI to roll them into a Frame called “Spec v0” — every decision keeps its sources within arm’s reach.',
  },
  {
    eyebrow: 'Brainstorming',
    title: 'From sticky-note chaos to clustered themes',
    body: 'Drop one Text node per idea. When the canvas is full, hit ⌘+I to ask the AI to cluster everything into labelled frames — accept the change list and the surface tidies itself.',
  },
  {
    eyebrow: 'Coding agents',
    title: 'Pair Huabu with Claude / Copilot / Gemini CLIs',
    body: 'Through the Pluggable Agents bridge, your existing agent CLI drives the chat panel. The canvas is the agent’s scratchpad; sources, decisions and outputs all land where you can see them.',
    cta: { label: 'How it works', to: '/docs/core/pluggable-agents' },
  },
  {
    eyebrow: 'Reading club / study',
    title: 'Capture a curriculum on one infinite surface',
    body: 'Web articles, PDFs, your highlights, AI explanations, the questions still bothering you — all sit on the same canvas. Each Question node gets an AI reply right where the source material is.',
  },
];

export default function Showcase() {
  return (
    <article data-pagefind-body className="py-24">
      <header className="mb-20 space-y-4 text-center">
        <h1 className="text-fg-default text-4xl font-semibold tracking-tight">
          What people use Huabu for
        </h1>
        <P className="mx-auto max-w-2xl text-base">
          A short visual tour of the kinds of work the canvas fits. These
          aren&apos;t step-by-step recipes — they&apos;re snapshots of what a
          loaded Huabu canvas tends to look like.
        </P>
      </header>

      <div className="space-y-24">
        {scenes.map((scene, i) => (
          <Scene key={i} scene={scene} />
        ))}
      </div>

      <footer className="mt-24 rounded-2xl bg-gray-50 px-8 py-10 text-center">
        <H2>Ready to try it?</H2>
        <P className="mx-auto mt-2 max-w-xl text-base">
          The Quick Start walks you from a fresh install to a productive canvas
          in four short steps.
        </P>
        <Link
          to="/docs/quickstart"
          className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-2 text-[14px] font-medium text-white transition-colors hover:bg-gray-700"
        >
          Open Quick Start
          <ArrowRight className="h-4 w-4" />
        </Link>
      </footer>
    </article>
  );
}

function Scene({ scene }: { scene: ShowcaseScene }) {
  return (
    <section className={cn('rounded-2xl border border-gray-200 bg-white p-8')}>
      <div className="max-w-3xl space-y-3">
        <span className="text-fg-muted text-[12px] font-medium tracking-wide uppercase">
          {scene.eyebrow}
        </span>
        <h2 className="text-fg-default text-2xl font-semibold tracking-tight">
          {scene.title}
        </h2>
        <p className="text-[15.5px] leading-relaxed text-gray-700">
          {scene.body}
        </p>
        {scene.cta && (
          <Link
            to={scene.cta.to}
            className="text-fg-default inline-flex items-center gap-1 pt-1 text-[14px] font-medium underline-offset-4 hover:underline"
          >
            {scene.cta.label}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    </section>
  );
}
