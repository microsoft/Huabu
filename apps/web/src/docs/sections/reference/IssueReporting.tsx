import {
  Callout,
  Code,
  CodeBlock,
  DocLink,
  H2,
  H3,
  P,
  PageLayout,
  Table,
  type TocEntry,
} from '../../components';

const toc: TocEntry[] = [
  { id: 'before-filing', label: 'Before you file' },
  { id: 'what-to-include', label: 'What to include in a bug report' },
  { id: 'logs', label: 'Where to find logs' },
  { id: 'feature-requests', label: 'Feature requests' },
  { id: 'security', label: 'Security issues' },
];

export default function IssueReporting() {
  return (
    <PageLayout
      title="Reporting Issues"
      description="When something feels wrong — a crash, a wrong AI edit, a sync glitch — a short, specific issue is the fastest path to a fix. Here's how to file one that's easy to act on."
      toc={toc}
    >
      <H2>Before you file</H2>
      <ul className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>
          <strong>Search existing issues</strong> on{' '}
          <DocLink href="https://github.com/hai-team/Sediment/issues">
            GitHub
          </DocLink>{' '}
          — your symptom may already be tracked.
        </li>
        <li>
          <strong>Try a fresh canvas.</strong> If the bug doesn&apos;t reproduce
          on an empty canvas, it&apos;s likely tied to a specific node or
          operation — that&apos;s a useful data point.
        </li>
        <li>
          <strong>Check the changelog.</strong> A recent release may have
          changed behaviour intentionally — see{' '}
          <DocLink href="/docs/reference/changelog">Changelog</DocLink>.
        </li>
      </ul>

      <H2>What to include in a bug report</H2>
      <P>
        Fill in as many of these as you can. Don&apos;t worry about being
        exhaustive — the first three are the most important:
      </P>
      <Table
        headers={['Field', 'What to put']}
        rows={[
          [
            <strong>What happened</strong>,
            'One sentence describing the observed behaviour.',
          ],
          [
            <strong>What you expected</strong>,
            'What you were trying to do, and what the correct outcome would have looked like.',
          ],
          [
            <strong>Steps to reproduce</strong>,
            'A numbered list, starting from "open Huabu" or "open canvas X". If you can\'t reproduce reliably, say so — intermittent bugs still matter.',
          ],
          [
            <strong>Environment</strong>,
            <>
              OS + version, Huabu version (from <em>Settings → About</em>),
              browser if you&apos;re on the web build.
            </>,
          ],
          [
            <strong>Screenshot / screen recording</strong>,
            'Worth a thousand words for canvas glitches and layout bugs.',
          ],
          [
            <strong>Logs</strong>,
            'See the next section. Trim to the relevant time window if they are long.',
          ],
        ]}
      />

      <Callout tone="tip">
        If a specific canvas reproduces the bug and you&apos;re willing to share
        it, export it to a <Code>.zip</Code> bundle from the canvas list and
        attach that. The team can drop it straight into a workspace and click
        around.
      </Callout>

      <H2>Where to find logs</H2>
      <H3>Server logs</H3>
      <P>
        The Sediment server prints to its terminal. If you started it via{' '}
        <Code>pnpm dev</Code>, the relevant lines are in that terminal pane. For
        long sessions, redirect to a file:
      </P>
      <CodeBlock language="bash">{`pnpm dev 2>&1 | tee huabu-server.log`}</CodeBlock>

      <H3>Browser console</H3>
      <P>
        Open DevTools (<Code>F12</Code> on most browsers) and copy the Console +
        Network tabs. The first red error after the misbehaviour usually points
        at the offending request.
      </P>

      <H3>Canvas history</H3>
      <P>
        Each canvas keeps a <Code>.history/</Code> directory with chat
        transcripts and intent suggestions. Attach the relevant file if the bug
        is about AI behaviour — but skim it first for anything sensitive
        you&apos;d rather not share.
      </P>

      <H2>Feature requests</H2>
      <P>
        Open them in the same{' '}
        <DocLink href="https://github.com/hai-team/Sediment/issues">
          issue tracker
        </DocLink>
        , labelled <Code>enhancement</Code>. The most actionable shape is:
      </P>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700">
        <li>The workflow you&apos;re trying to support.</li>
        <li>How you do it today, and what about that hurts.</li>
        <li>One or two concrete shapes the feature could take.</li>
      </ol>
      <P>
        Skip step 3 if you&apos;re not sure — describing the problem clearly is
        more valuable than proposing the solution.
      </P>

      <H2>Security issues</H2>
      <Callout tone="warning">
        Please <strong>do not</strong> file security issues as public GitHub
        issues. Instead, follow the disclosure instructions in the
        repository&apos;s <Code>SECURITY.md</Code> (or the project README&apos;s
        contact section).
      </Callout>
    </PageLayout>
  );
}
