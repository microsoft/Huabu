// TODO: fill in real handbook content for this section.
import {
  Callout,
  DocLink,
  H2,
  P,
  PageLayout,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'where-to-find-it', label: 'Where to find it' },
  { id: 'format', label: 'Format' },
];

export default function Changelog() {
  return (
    <PageLayout
      title="Changelog"
      description="A running record of user-facing changes, sorted newest-first. Each entry calls out what changed and any caveats users should know about."
      toc={toc}
    >
      <H2>Where to find it</H2>
      <P>
        The canonical changelog lives in the repository as a Markdown document:{' '}
        <DocLink href="https://github.com/hai-team/Sediment/blob/main/docs/user-guide/CHANGELOG.md">
          docs/user-guide/CHANGELOG.md
        </DocLink>
        . New entries are added at the top whenever a release touches
        user-facing behaviour (UI, workflow, shortcuts, defaults).
      </P>

      <H2>Format</H2>
      <P>Every entry has two sections:</P>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>What Changed</strong> — a concise description of what&apos;s
          new or different.
        </li>
        <li>
          <strong>Notes</strong> — caveats, migration steps, or anything you
          should be aware of.
        </li>
      </ul>
      <Callout tone="info">
        Maintaining a fork or downstream build? Treat the changelog as the
        authoritative source for breaking changes — this handbook describes the
        current behaviour, not the transitions between versions.
      </Callout>
    </PageLayout>
  );
}
